/**
 * ============================================================
 *  카페24 판매관리 시스템 v2.2 — DB 기반 주문 저장 + 고속 조회
 * ============================================================
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const Cafe24Client = require('./cafe24-client');
const CoupangClient = require('./services/coupang-client');
const NaverCommerceClient = require('./services/naver-client');
const MultiChannelService = require('./services/multichannel-service');
const multiChannelRouter = require('./routes/multichannel');
const OrderDB = require('./db/order-db');

const config = {
  cafe24: { mallId: process.env.CAFE24_MALL_ID || 'yourmall', clientId: process.env.CAFE24_CLIENT_ID || '', clientSecret: process.env.CAFE24_CLIENT_SECRET || '', redirectUri: process.env.CAFE24_REDIRECT_URI || 'http://localhost:3000/auth/callback', apiVersion: process.env.CAFE24_API_VERSION || '2026-03-01', tokenStorePath: process.env.TOKEN_STORE_PATH || (process.env.RAILWAY_ENVIRONMENT ? '/app/persistent/tokens.json' : './tokens.json') },
  coupang: { vendorId: process.env.COUPANG_VENDOR_ID || '', accessKey: process.env.COUPANG_ACCESS_KEY || '', secretKey: process.env.COUPANG_SECRET_KEY || '' },
  naver: { clientId: process.env.NAVER_COMMERCE_CLIENT_ID || '', clientSecret: process.env.NAVER_COMMERCE_CLIENT_SECRET || '' },
};

const cafe24 = new Cafe24Client(config.cafe24);
const coupang = config.coupang.accessKey ? new CoupangClient(config.coupang) : null;
const naver = config.naver.clientId ? new NaverCommerceClient(config.naver) : null;
const multiChannel = new MultiChannelService({ cafe24Client: cafe24, coupangClient: coupang, naverClient: naver });

const orderDB = new OrderDB();
let dbReady = false;

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const MAX_COLLECT_DAYS = 30;

// ═══════════════════════════════════════════════
//  서버 즉시 시작 (Railway healthcheck 통과)
// ═══════════════════════════════════════════════
// persistent 볼륨 디렉토리 자동 생성
const persistDir = process.env.RAILWAY_ENVIRONMENT ? '/app/persistent' : null;
if (persistDir) { try { require('fs').mkdirSync(persistDir, {recursive:true}); } catch(e){} }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  카페24 판매관리 v2.2 — http://localhost:${PORT}`);
  console.log(`  DB: 초기화 중...\n`);
});

// ═══════════════════════════════════════════════
//  부팅 시퀀스: DB → 토큰 복구 → 초기 수집
// ═══════════════════════════════════════════════
orderDB.ensureReady().then(async () => {
  dbReady = true;
  cafe24.setDB(orderDB);
  console.log('[Boot] DB 준비 완료');

  // 토큰 자동 복구
  const authOk = await cafe24.autoRecover().catch(e => { console.error('[Boot] 토큰 복구 실패:', e.message); return false; });
  console.log(`[Boot] 카페24: ${authOk ? '인증됨' : '미인증'} | 쿠팡: ${coupang ? '설정됨' : '미설정'} | 네이버: ${naver ? '설정됨' : '미설정'}`);

  // 인증 성공 시 서버 시작 직후 1회 수집 (최근 1일)
  if (authOk || coupang || naver) {
    console.log('[Boot] 초기 주문 수집 시작 (최근 1일)...');
    const result = await collector.collectAll('auto-boot', { days: 1 });
    if (result.success) {
      console.log(`[Boot] 초기 수집 완료: ${result.data.totalCount}건 수집, ${result.data.totalSaved}건 DB 저장`);
    }
  }
}).catch(e => console.error('[Boot] DB 초기화 실패:', e.message));


// ═══════════════════════════════════════════════
//  주문 수집 엔진
// ═══════════════════════════════════════════════

const collector = {
  isRunning: false, lastRun: null,

  /** 수집 가능한 채널이 하나라도 있는지 확인 */
  hasAnyChannel() {
    return !!(cafe24.tokens?.access_token || coupang || naver);
  },

  async collectChannel(channelName, fetchFn) {
    const start = Date.now();
    try {
      const result = await fetchFn();
      const orders = Array.isArray(result) ? result : (result?.orders || result?.data || []);
      let saved = 0;
      if (dbReady) {
        const sr = orderDB.saveOrders(channelName, orders);
        saved = sr.inserted;
      }
      console.log(`[Collector] ${channelName}: ${orders.length}건 수집` + (dbReady ? ` → DB ${saved}건` : ''));
      return { channel: channelName, status: 'success', count: orders.length, saved, latency: Date.now() - start };
    } catch (e) {
      return { channel: channelName, status: 'error', error: e.message, count: 0, saved: 0, latency: Date.now() - start };
    }
  },

  async collectAll(trigger = 'auto', { days = 1, startDate, endDate } = {}) {
    if (this.isRunning) return { success: false, error: '수집이 이미 진행 중입니다.' };

    // 자동 수집 시 인증된 채널이 없으면 건너뜀
    if (trigger.startsWith('auto') && !this.hasAnyChannel()) {
      console.log('[Collector] 인증된 채널 없음 — 수집 건너뜀');
      return { success: false, error: '인증된 채널 없음' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const now = new Date();

    let collectStart, collectEnd;
    if (startDate && endDate) {
      collectStart = startDate; collectEnd = endDate;
      const diff = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);
      if (diff > MAX_COLLECT_DAYS) { this.isRunning = false; return { success: false, error: `최대 ${MAX_COLLECT_DAYS}일` }; }
      if (diff < 0) { this.isRunning = false; return { success: false, error: '시작일 > 종료일' }; }
    } else {
      const d = Math.max(1, Math.min(days, MAX_COLLECT_DAYS));
      collectStart = new Date(now.getTime() - d * 86400000).toISOString().substring(0, 10);
      collectEnd = now.toISOString().substring(0, 10);
    }
    const periodDays = Math.ceil((new Date(collectEnd) - new Date(collectStart)) / 86400000) || 1;
    console.log(`[Collector] ${trigger} 수집 (${collectStart}~${collectEnd}, ${periodDays}일)`);

    const results = await Promise.allSettled([
      this.collectChannel('카페24', async () => { if (!cafe24.tokens?.access_token) throw new Error('미인증'); return cafe24.getAllOrders(collectStart, collectEnd); }),
      this.collectChannel('쿠팡', async () => { if (!coupang) throw new Error('미설정'); return coupang.getAllOrders(new Date(collectStart).toISOString(), new Date(collectEnd+'T23:59:59').toISOString()); }),
      this.collectChannel('네이버', async () => { if (!naver) throw new Error('미설정'); return naver.getAllOrders(collectStart, collectEnd); }),
    ]);

    const channels = results.map(r => r.status === 'fulfilled' ? r.value : { channel: '?', status: 'error', error: r.reason?.message, count: 0, saved: 0, latency: 0 });
    const record = {
      trigger, timestamp: now.toISOString(), duration: Date.now() - startTime,
      period: { start: collectStart, end: collectEnd, days: periodDays },
      totalCount: channels.reduce((s, c) => s + c.count, 0),
      totalSaved: channels.reduce((s, c) => s + (c.saved || 0), 0),
      channels,
    };

    if (dbReady) try { orderDB.saveCollectHistory(record); } catch(e) {}
    this.lastRun = record;
    this.isRunning = false;
    console.log(`[Collector] 완료: ${record.totalCount}건 수집 / ${record.totalSaved}건 저장 (${record.duration}ms)`);
    return { success: true, data: record };
  },

  getStatus() {
    return {
      isRunning: this.isRunning, lastRun: this.lastRun, maxDays: MAX_COLLECT_DAYS,
      schedule: '*/30 * * * *', scheduleDesc: '30분마다', dbReady,
      db: dbReady ? orderDB.getStats() : { totalOrders: 0, dbSize: '초기화중' },
      channels: {
        카페24: { configured: !!config.cafe24.clientId, authenticated: !!cafe24.tokens?.access_token },
        쿠팡: { configured: !!config.coupang.accessKey },
        네이버: { configured: !!config.naver.clientId },
      },
    };
  },
};


// ═══════════════════════════════════════════════
//  A. OAuth
// ═══════════════════════════════════════════════
app.get('/auth/login', (req, res) => { const { url } = cafe24.getAuthorizationUrl(); res.redirect(url); });
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ success: false, error });
  if (!code) return res.status(400).json({ success: false, error: '코드 없음' });
  try {
    const tokens = await cafe24.getAccessToken(code);
    console.log('[Auth] 성공 — CAFE24_REFRESH_TOKEN=' + tokens.refresh_token);
    // 인증 직후 자동 수집 트리거 (비동기, 응답 차단 안함)
    setTimeout(() => {
      console.log('[Auth] 인증 후 자동 수집 시작 (최근 7일)...');
      collector.collectAll('auto-auth', { days: 7 });
    }, 2000);
    res.redirect('/?auth=success');
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/auth/status', (req, res) => {
  const ch = [];
  if (cafe24.tokens?.access_token) { const exp = new Date(cafe24.tokens.expires_at); ch.push({ channel: '카페24', authenticated: true, valid: exp > new Date() }); }
  else ch.push({ channel: '카페24', authenticated: false });
  ch.push({ channel: '쿠팡', authenticated: !!config.coupang.accessKey, valid: !!config.coupang.accessKey });
  ch.push({ channel: '네이버', authenticated: !!config.naver.clientId, valid: !!config.naver.clientId });
  res.json({ success: true, channels: ch });
});


// ═══════════════════════════════════════════════
//  B. 기존 API
// ═══════════════════════════════════════════════
app.get('/api/orders', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrders(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/orders/all', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date||!end_date) return res.status(400).json({success:false,error:'날짜 필수'}); const o = await cafe24.getAllOrders(start_date,end_date); res.json({success:true,count:o.length,data:o}); } catch(e){ha(res,e);} });
app.get('/api/orders/:orderId', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrder(req.params.orderId) }); } catch (e) { ha(res, e); } });
app.get('/api/orders-count', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrdersCount(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/products', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProducts(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/products/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProduct(req.params.productNo) }); } catch (e) { ha(res, e); } });
app.get('/api/inventory/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getInventory(req.params.productNo) }); } catch (e) { ha(res, e); } });
app.put('/api/inventory/:productNo/:variantCode', async (req, res) => { try { res.json({ success: true, data: await cafe24.updateInventory(req.params.productNo, req.params.variantCode, req.body) }); } catch (e) { ha(res, e); } });
app.get('/api/inventory-report', async (req, res) => { try { const r = await cafe24.getFullInventoryReport(); res.json({ success: true, count: r.length, data: r }); } catch (e) { ha(res, e); } });
app.get('/api/analytics/sales', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date||!end_date) return res.status(400).json({success:false,error:'날짜 필수'}); res.json({ success: true, data: await cafe24.getSalesAnalytics(start_date, end_date) }); } catch (e) { ha(res, e); } });
app.get('/api/dashboard', async (req, res) => { try { res.json({ success: true, data: await cafe24.getDashboard() }); } catch (e) { ha(res, e); } });
app.get('/api/coupang/orders', async (req, res) => { if (!coupang) return res.status(400).json({success:false,error:'쿠팡 미설정'}); try { res.json({ success: true, data: await coupang.getOrders(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/coupang/products', async (req, res) => { if (!coupang) return res.status(400).json({success:false,error:'쿠팡 미설정'}); try { res.json({ success: true, data: await coupang.getProducts(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/naver/orders', async (req, res) => { if (!naver) return res.status(400).json({success:false,error:'네이버 미설정'}); try { res.json({ success: true, data: await naver.getOrders(req.query) }); } catch (e) { ha(res, e); } });
app.get('/api/naver/products', async (req, res) => { if (!naver) return res.status(400).json({success:false,error:'네이버 미설정'}); try { res.json({ success: true, data: await naver.getProducts(req.query) }); } catch (e) { ha(res, e); } });
app.use('/api/multichannel', multiChannelRouter(multiChannel));


// ═══════════════════════════════════════════════
//  C. DB 기반 고속 조회
// ═══════════════════════════════════════════════

app.get('/api/db/dashboard', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 초기화 중' });
  try {
    const days = parseInt(req.query.days) || 30;
    const now = new Date();
    const s = new Date(now.getTime() - days * 86400000).toISOString().substring(0, 10);
    const e = now.toISOString().substring(0, 10);
    res.json({ success: true, data: orderDB.getDashboardData(s, e) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/db/sales', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 초기화 중' });
  try {
    const { start_date, end_date, channel } = req.query;
    if (!start_date || !end_date) return res.status(400).json({ success: false, error: '날짜 필수' });
    res.json({ success: true, data: { summary: orderDB.getSalesSummary(start_date, end_date), daily: orderDB.getDailySales(start_date, end_date, channel), topProducts: orderDB.getTopProducts(start_date, end_date), fromDB: true } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/db/orders', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 초기화 중' });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const orders = orderDB.getRecentOrders(limit, req.query.channel);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/db/stats', (req, res) => {
  if (!dbReady) return res.json({ success: true, data: { totalOrders: 0, status: 'initializing' } });
  try { res.json({ success: true, data: orderDB.getStats() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ═══════════════════════════════════════════════


// ═══════════════════════════════════════════════
//  C2. 재고관리 API (/api/inventory-mgmt/*)
// ═══════════════════════════════════════════════

const XLSX = require('xlsx');

/** POST /api/inventory-mgmt/upload — 재고 엑셀 업로드 */
app.post('/api/inventory-mgmt/upload', require('multer')({ storage: require('multer').memoryStorage() }).single('file'), (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  if (!req.file) return res.status(400).json({ success: false, error: '파일 없음' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    const items = rows.map(r => ({
      product_code: String(r['상품코드'] || r['바코드'] || ''),
      barcode: String(r['바코드'] || ''),
      product_name: String(r['상품명'] || ''),
      option_name: String(r['옵션'] || ''),
      category: String(r['카테고리'] || ''),
      supplier: String(r['공급처'] || ''),
      supplier_option: String(r['공급처옵션'] || ''),
      cost_price: parseFloat(r['원가'] || 0),
      sell_price: parseFloat(r['판매가'] || 0),
      stock_qty: parseInt(r['가용재고'] || r['정상+창고 가용재고'] || 0),
      defect_qty: parseInt(r['불량재고'] || 0),
    })).filter(it => it.product_name);

    const baseDate = req.body?.base_date || new Date().toISOString().substring(0, 10);
    const result = orderDB.saveInventory(items, baseDate);
    res.json({ success: true, data: { ...result, totalRows: rows.length, parsed: items.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


/** POST /api/inventory-mgmt/upload-base64 — base64 재고 업로드 */
app.post("/api/inventory-mgmt/upload-base64", (req, res) => {
  if (!dbReady) return res.json({ success: false, error: "DB 미준비" });
  try {
    const buf = Buffer.from(req.body.data, "base64");
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    const items = rows.map(r => ({
      product_code: String(r["상품코드"] || r["바코드"] || ""),
      barcode: String(r["바코드"] || ""),
      product_name: String(r["상품명"] || ""),
      option_name: String(r["옵션"] || ""),
      category: String(r["카테고리"] || ""),
      supplier: String(r["공급처"] || ""),
      supplier_option: String(r["공급처옵션"] || ""),
      cost_price: parseFloat(r["원가"] || 0),
      sell_price: parseFloat(r["판매가"] || 0),
      stock_qty: parseInt(r["가용재고"] || r["정상+창고 가용재고"] || 0),
      defect_qty: parseInt(r["불량재고"] || 0),
    })).filter(it => it.product_name);
    const baseDate = req.body.base_date || new Date().toISOString().substring(0, 10);
    const result = orderDB.saveInventory(items, baseDate);
    res.json({ success: true, data: { ...result, totalRows: rows.length, parsed: items.length, baseDate } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
/** GET /api/inventory-mgmt/list — 재고 목록 */
app.get('/api/inventory-mgmt/list', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const items = orderDB.getInventory({
      category: req.query.category,
      search: req.query.search,
      stockOnly: req.query.stock_only === 'true',
      limit: parseInt(req.query.limit) || 200,
    });
    res.json({ success: true, count: items.length, data: items });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** GET /api/inventory-mgmt/stats — 재고 통계 */
app.get('/api/inventory-mgmt/stats', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try { res.json({ success: true, data: orderDB.getInventoryStats() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** GET /api/inventory-mgmt/stock — 재고 현황 자동 계산 */
app.get('/api/inventory-mgmt/stock', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const date = req.query.date || new Date().toISOString().substring(0, 10);
    const opts = { search: req.query.search||'', supplier: req.query.supplier||'', category: req.query.category||'', shippedOnly: req.query.shipped_only==='true', limit: parseInt(req.query.limit)||200 };
    const result = orderDB.getStockStatus(date, opts);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
/** GET /api/inventory-mgmt/stock-filters — 필터 목록 */
app.get('/api/inventory-mgmt/stock-filters', (req, res) => {
  if (!dbReady) return res.json({ success: true, data: { suppliers: [], categories: [] } });
  try {
    const suppliers = orderDB.db.exec("SELECT DISTINCT supplier FROM inventory WHERE supplier != '' ORDER BY supplier")[0]?.values?.map(r=>r[0]) || [];
    const categories = orderDB.db.exec("SELECT DISTINCT category FROM inventory WHERE category != '' ORDER BY category")[0]?.values?.map(r=>r[0]) || [];
    res.json({ success: true, data: { suppliers, categories } });
  } catch (err) { res.json({ success: true, data: { suppliers: [], categories: [] } }); }
});
/** GET /api/inventory-mgmt/margin — 상품별 마진 분석 (product_no + 상품명 복합 매칭) */
app.get('/api/inventory-mgmt/margin', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const { start_date, end_date } = req.query;
    const sd = start_date || '2026-01-01';
    const ed = end_date || new Date().toISOString().substring(0, 10);

    // 주문 DB에서 상품별 매출/수량 집계 (product_no 포함)
    const salesRows = orderDB.db.exec(`
      SELECT product_name, product_no, SUM(quantity) as total_qty, SUM(amount) as total_revenue, COUNT(*) as order_count, variant_code
      FROM orders WHERE order_date BETWEEN '${sd}' AND '${ed}'
      AND product_name != '' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED'
      GROUP BY product_name, product_no, variant_code ORDER BY SUM(amount) DESC LIMIT 100
    `)[0]?.values || [];

    // 재고 DB에서 원가 매핑 테이블 구축 (supplier_option이 핵심 매칭 키)
    const invRows = orderDB.db.exec('SELECT product_code, barcode, product_name, option_name, supplier_option, cost_price, sell_price FROM inventory WHERE cost_price > 0')[0]?.values || [];
    const costBySupplierOpt = {};  // 공급처옵션 → {cost, sell, name}
    const costByCode = {};  // product_code/barcode → {cost, sell, name}
    const costByName = {};  // 상품명 → {cost, sell}
    for (const [code, barcode, name, opt, supplierOpt, cost, sell] of invRows) {
      const entry = { cost, sell, name, option: opt };
      // 1순위 매칭 키: 공급처옵션 (카페24 custom_variant_code와 매칭)
      if (supplierOpt) costBySupplierOpt[supplierOpt] = entry;
      if (code) costByCode[code] = entry;
      if (barcode && barcode !== code) costByCode[barcode] = entry;
      if (!costByName[name]) costByName[name] = entry;
    }

    const items = salesRows.map((salesRow) => {
      const [name, productNo, qty, revenue, orders, variantCode] = salesRow;
      let matched = null;
      let matchType = 'none';
      let matchedName = '';

      // 1순위: variant_code(custom_variant_code) → supplier_option(공급처옵션) 매칭
      if (variantCode && costBySupplierOpt[variantCode]) {
        matched = costBySupplierOpt[variantCode];
        matchType = 'code';
        matchedName = matched.name;
      }

      // 2순위: product_no → barcode/product_code 매칭
      if (!matched && productNo && costByCode[productNo]) {
        matched = costByCode[productNo];
        matchType = 'code';
        matchedName = matched.name;
      }

      // 3순위: 상품명 정확 매칭
      if (!matched && costByName[name]) {
        matched = costByName[name];
        matchType = 'exact';
        matchedName = matched.name;
      }

      // 3순위: 상품명 부분 매칭 (주문 상품명의 키워드가 재고 상품명에 포함)
      if (!matched) {
        // 주문 상품명에서 핵심 키워드 추출 ([] 제거, 공백 분할)
        const keywords = name.replace(/\[.*?\]/g, '').trim().split(/\s+/).filter(w => w.length >= 2);
        for (const [invName, entry] of Object.entries(costByName)) {
          // 키워드 2개 이상 매칭되면 부분 매칭
          const matchCount = keywords.filter(kw => invName.includes(kw)).length;
          if (matchCount >= 2 && matchCount >= keywords.length * 0.4) {
            matched = entry;
            matchType = 'partial';
            matchedName = invName;
            break;
          }
        }
      }

      const costPrice = matched ? matched.cost : 0;
      const sellPrice = matched ? matched.sell : 0;
      const totalCost = costPrice * qty;
      const margin = revenue - totalCost;
      const marginRate = revenue > 0 ? Math.round(margin / revenue * 1000) / 10 : 0;
      const unitMargin = qty > 0 ? Math.round((revenue / qty) - costPrice) : 0;

      return {
        product_name: name,
        product_no: productNo || '',
        matched_inv_name: matchedName,
        total_qty: qty,
        total_revenue: revenue,
        order_count: orders,
        cost_price: costPrice,
        sell_price: sellPrice,
        total_cost: totalCost,
        margin: margin,
        margin_rate: marginRate,
        unit_margin: unitMargin,
        match_type: matchType
      };
    });

    // 요약
    const totalRevenue = items.reduce((s, i) => s + i.total_revenue, 0);
    const totalCost = items.reduce((s, i) => s + i.total_cost, 0);
    const totalMargin = totalRevenue - totalCost;
    const matchedItems = items.filter(i => i.match_type !== 'none');
    const matchedRevenue = matchedItems.reduce((s, i) => s + i.total_revenue, 0);
    const matchedCost = matchedItems.reduce((s, i) => s + i.total_cost, 0);
    const matchedMargin = matchedRevenue - matchedCost;

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue, totalCost, totalMargin,
          marginRate: totalRevenue > 0 ? Math.round(totalMargin / totalRevenue * 1000) / 10 : 0,
          matchedRevenue, matchedCost, matchedMargin,
          matchedMarginRate: matchedRevenue > 0 ? Math.round(matchedMargin / matchedRevenue * 1000) / 10 : 0,
          matchedProducts: matchedItems.length,
          unmatchedProducts: items.length - matchedItems.length,
          period: { start: sd, end: ed }
        },
        items
      }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

//  D. 수집 API
// ═══════════════════════════════════════════════

app.post('/api/collector/run', async (req, res) => {
  try {
    const { days, start_date, end_date } = req.body || {};
    res.json(await collector.collectAll('manual', { days: days || 1, startDate: start_date, endDate: end_date }));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/collector/status', (req, res) => { res.json({ success: true, data: collector.getStatus() }); });
app.get('/api/collector/history', (req, res) => {
  if (!dbReady) return res.json({ success: true, data: [] });
  try { res.json({ success: true, data: orderDB.getCollectHistory(Math.min(parseInt(req.query.limit)||20, 50)) }); }
  catch(e) { res.json({ success: true, data: [] }); }
});
app.get('/api/collector/last', (req, res) => { res.json({ success: true, data: collector.lastRun }); });

app.get('/api/config/status', (req, res) => {
  res.json({ success: true, data: {
    cafe24: { configured: !!config.cafe24.clientId, mallId: config.cafe24.mallId, authenticated: !!cafe24.tokens?.access_token },
    coupang: { configured: !!config.coupang.accessKey },
    naver: { configured: !!config.naver.clientId },
    db: dbReady ? orderDB.getStats() : { status: 'initializing' },
  }});
});


// ═══════════════════════════════════════════════
//  E. 30분 자동 수집 스케줄러
// ═══════════════════════════════════════════════

cron.schedule('*/30 * * * *', async () => {
  if (!dbReady) { console.log('[Cron] DB 미준비 — 건너뜀'); return; }
  if (!collector.hasAnyChannel()) { console.log('[Cron] 인증된 채널 없음 — 건너뜀'); return; }
  console.log('[Cron] 30분 자동 수집 시작...');
  const result = await collector.collectAll('auto', { days: 1 });
  if (result.success) {
    console.log(`[Cron] 자동 수집 완료: ${result.data.totalCount}건 / ${result.data.totalSaved}건 저장`);
  } else {
    console.log('[Cron] 자동 수집 실패:', result.error);
  }
});

// 매 시간 매출 로그
cron.schedule('0 * * * *', () => {
  if (!dbReady) return;
  try {
    const now = new Date();
    const s = new Date(now.getTime()-86400000).toISOString().substring(0,10);
    const e = now.toISOString().substring(0,10);
    const sm = orderDB.getSalesSummary(s, e);
    const t = sm.reduce((a,r)=>a+r.total_amount,0);
    const c = sm.reduce((a,r)=>a+r.order_count,0);
    console.log(`[Cron] 일간 DB 매출: ${Math.round(t).toLocaleString()}원 (${c}건)`);
  } catch(e) {}
});

function ha(res, err) { console.error('[API]', err.message); res.status(err.statusCode||500).json({success:false,error:err.message}); }

// ═══════════════════════════════════════════════
//  토큰 관리 API
// ═══════════════════════════════════════════════

/** GET /api/auth/refresh-token — 현재 refresh_token 조회 (환경변수 설정용) */
app.get('/api/auth/refresh-token', (req, res) => {
  const rt = cafe24.tokens?.refresh_token || '';
  const at = cafe24.tokens?.access_token ? '있음' : '없음';
  const exp = cafe24.tokens?.expires_at || '';
  const rtExp = cafe24.tokens?.refresh_token_expires_at || '';
  res.json({
    success: true,
    data: {
      hasAccessToken: !!cafe24.tokens?.access_token,
      accessTokenStatus: at,
      expiresAt: exp,
      refreshToken: rt,
      refreshTokenExpiresAt: rtExp,
      hint: rt ? 'Railway Variables에 CAFE24_REFRESH_TOKEN=' + rt + ' 설정하세요' : '먼저 /auth/login으로 인증하세요'
    }
  });
});

app.get('/api/debug/test', async (req, res) => {
  try { const https=require('https'); const token=cafe24.tokens?cafe24.tokens.access_token:null; const m=cafe24.config.mallId; const v=cafe24.config.apiVersion; const r=await new Promise((ok,no)=>{const o={hostname:m+'.cafe24api.com',path:'/api/v2/admin/orders?limit=1',method:'GET',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','X-Cafe24-Api-Version':v}};const q=https.request(o,rs=>{let d='';rs.on('data',c=>d+=c);rs.on('end',()=>ok({status:rs.statusCode,body:d.substring(0,500)}))});q.on('error',no);q.end()}); res.json(r); }
  catch(e){res.json({error:e.message})}
});

module.exports = app;
