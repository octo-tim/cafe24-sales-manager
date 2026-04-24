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
app.use(express.static(path.join(__dirname, '..', 'public'), { 
  etag: false, 
  maxAge: 0,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const MAX_COLLECT_DAYS = 30;

/** KST(UTC+9) 기준 날짜 문자열 반환 */
function kstToday() {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  return now.toISOString().substring(0, 10);
}
function kstDaysAgo(days) {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  now.setDate(now.getDate() - days);
  return now.toISOString().substring(0, 10);
}

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
  const stats = orderDB.getStats();
  console.log('[Boot] DB 준비 완료 — 주문:', stats.totalOrders, '건, 재고:', stats.inventoryProducts, '종, DB:', stats.dbSize);

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
}).catch(async (e) => {
  console.error('[Boot] DB 초기화 실패:', e.message, '— 새 DB로 진행');
  try {
    await orderDB._ready;
  } catch(e2) {}
  dbReady = true;
  cafe24.setDB(orderDB);
  const authOk = await cafe24.autoRecover().catch(() => false);
  console.log('[Boot] 복구 완료 — 인증:', authOk ? '성공' : '실패');
});


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
    this._startTime = Date.now();
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
      collectStart = kstDaysAgo(d);
      collectEnd = kstToday();
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
/** POST /auth/refresh — 카페24 토큰 강제 갱신 */
app.post('/auth/refresh', async (req, res) => {
  try {
    await cafe24.refreshAccessToken();
    res.json({ success: true, message: '토큰 갱신 성공', expiresAt: cafe24.tokens?.expires_at });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/** POST /api/collector/reset — 수집 상태 강제 리셋 */
app.post('/api/collector/reset', (req, res) => {
  collector.isRunning = false;
  res.json({ success: true, message: '수집 상태 리셋 완료' });
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
    const s = kstDaysAgo(days);
    const e = kstToday();
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
    const today = new Date().toISOString().substring(0, 10);
    const startDate = req.query.start_date || req.query.date || today;
    const endDate = req.query.end_date || req.query.date || today;
    const opts = { search: req.query.search||'', supplier: req.query.supplier||'', category: req.query.category||'', shippedOnly: req.query.shipped_only==='true', limit: parseInt(req.query.limit)||200 };
    const result = orderDB.getStockStatus(startDate, endDate, opts);
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
/** POST /api/ecount/upload — 이카운트 상품 원가 업로드 (JSON) */
app.post('/api/ecount/upload', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const items = req.body.items || req.body;
    const append = req.body.append === true; // append=true면 기존 데이터 유지
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: '데이터 없음' });
    if (append) {
      const result = orderDB.appendEcountProducts(items);
      res.json({ success: true, data: result });
    } else {
      const result = orderDB.saveEcountProducts(items);
      res.json({ success: true, data: result });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** POST /api/ecount/upload-base64 — 이카운트 엑셀 base64 업로드 */
app.post('/api/ecount/upload-base64', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const buf = Buffer.from(req.body.data, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      if (rows[i] && rows[i].some(c => String(c||'').includes('품목코드'))) { headerIdx = i; break; }
    }
    const items = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      items.push({
        code: String(r[0]||'').trim(), barcode: String(r[1]||'').trim(),
        name: String(r[2]||'').trim(), option: String(r[3]||'').trim(),
        cost: parseFloat(String(r[4]||'0').replace(/,/g,'')) || 0,
        sell: parseFloat(String(r[5]||'0').replace(/,/g,'')) || 0,
        category: String(r[6]||'').trim(), supplier: String(r[9]||'').trim()
      });
    }
    const result = orderDB.saveEcountProducts(items);
    res.json({ success: true, data: { ...result, totalRows: rows.length, parsed: items.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** POST /api/ecount/upload-xlsx — 이카운트 엑셀 직접 업로드 */
app.post('/api/ecount/upload-xlsx', require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 50*1024*1024 } }).single('file'), (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  if (!req.file) return res.status(400).json({ success: false, error: '파일 없음' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    // 헤더 찾기 (품목코드가 있는 행)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      if (rows[i] && rows[i].some(c => String(c||'').includes('품목코드'))) { headerIdx = i; break; }
    }
    const items = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const cost = parseFloat(String(r[4]||'0').replace(/,/g,'')) || 0;
      const sell = parseFloat(String(r[5]||'0').replace(/,/g,'')) || 0;
      items.push({
        code: String(r[0]||'').trim(),
        barcode: String(r[1]||'').trim(),
        name: String(r[2]||'').trim(),
        option: String(r[3]||'').trim(),
        cost: cost,
        sell: sell,
        category: String(r[6]||'').trim(),
        supplier: String(r[9]||'').trim()
      });
    }
    const result = orderDB.saveEcountProducts(items);
    res.json({ success: true, data: { ...result, totalRows: rows.length, parsed: items.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** POST /api/ecount/seed — 이카운트 데이터 시드 (chunk 단위) */
app.post('/api/ecount/seed', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const { items, reset } = req.body;
    if (!Array.isArray(items)) return res.json({ success: false, error: 'items 필요' });
    if (reset) orderDB.db.run('DELETE FROM ecount_products');
    const stmt = orderDB.db.prepare('INSERT OR IGNORE INTO ecount_products (item_code, barcode, item_name, option_name, cost_price, sell_price, category, supplier) VALUES (?,?,?,?,?,?,?,?)');
    let cnt = 0;
    for (const it of items) {
      try { stmt.run([it.code||'', it.barcode||'', it.name||'', it.option||'', it.cost||0, it.sell||0, it.category||'', it.supplier||'']); cnt++; } catch(e) {}
    }
    stmt.free();
    orderDB._persist();
    const total = orderDB.db.exec('SELECT COUNT(*) FROM ecount_products')[0]?.values?.[0]?.[0] || 0;
    res.json({ success: true, data: { inserted: cnt, total } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

/** GET /api/ecount/stats — 이카운트 상품 통계 */
app.get('/api/ecount/stats', (req, res) => {
  if (!dbReady) return res.json({ success: true, data: { count: 0 } });
  try {
    const count = orderDB.db.exec('SELECT COUNT(*) FROM ecount_products')[0]?.values?.[0]?.[0] || 0;
    const withCost = orderDB.db.exec('SELECT COUNT(*) FROM ecount_products WHERE cost_price > 0')[0]?.values?.[0]?.[0] || 0;
    res.json({ success: true, data: { count, withCost } });
  } catch(e) { res.json({ success: true, data: { count: 0 } }); }
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

    // ★ 원가 소스: 이카운트 상품리스트 (입고단가)
    const ecountMap = orderDB.getEcountCostMap();
    const ecByCode = ecountMap.byCode;      // 이카운트 품목코드 → {cost, sell, name}
    const ecByBarcode = ecountMap.byBarcode; // 이카운트 바코드 → {cost, sell, name}

    // ★ 매칭 키 소스: 재고 엑셀(이지어드민) — supplier_option으로 주문↔이카운트 연결
    const invRows = orderDB.db.exec('SELECT product_code, barcode, product_name, option_name, supplier_option FROM inventory')[0]?.values || [];
    // supplier_option → 이카운트 원가 매핑 (재고 엑셀이 중간 다리 역할)
    const costBySupplierOpt = {};
    for (const [code, barcode, name, opt, supplierOpt] of invRows) {
      if (!supplierOpt) continue;
      // supplier_option 자체가 이카운트 품목코드인 경우
      const ecMatch = ecByCode[supplierOpt] || ecByBarcode[supplierOpt] || ecByBarcode[barcode] || ecByBarcode[code];
      if (ecMatch) {
        costBySupplierOpt[supplierOpt] = { cost: ecMatch.cost, sell: ecMatch.sell, name: ecMatch.name, option: ecMatch.option, category: ecMatch.category || '', invName: name };
      }
    }

    const items = salesRows.map((salesRow) => {
      const [name, productNo, qty, revenue, orders, variantCode] = salesRow;
      let matched = null;
      let matchType = 'none';
      let matchedName = '';

      // 1순위: variant_code → 이카운트 품목코드 직접 매칭
      if (variantCode && ecByCode[variantCode]) {
        matched = ecByCode[variantCode];
        matchType = 'code';
        matchedName = matched.name;
      }

      // 2순위: variant_code → 이카운트 바코드 직접 매칭
      if (!matched && variantCode && ecByBarcode[variantCode]) {
        matched = ecByBarcode[variantCode];
        matchType = 'code';
        matchedName = matched.name;
      }

      // 3순위: variant_code → 재고 엑셀 supplier_option 경유 → 이카운트 원가
      if (!matched && variantCode && costBySupplierOpt[variantCode]) {
        matched = costBySupplierOpt[variantCode];
        matchType = 'code';
        matchedName = matched.invName || matched.name;
      }

      // 4순위: product_no → 이카운트 바코드/품목코드
      if (!matched && productNo) {
        if (ecByCode[productNo]) { matched = ecByCode[productNo]; matchType = 'code'; matchedName = matched.name; }
        else if (ecByBarcode[productNo]) { matched = ecByBarcode[productNo]; matchType = 'code'; matchedName = matched.name; }
      }

      const costPrice = matched ? matched.cost : 0;
      const sellPrice = matched ? matched.sell : 0;
      const totalCost = costPrice * qty;
      const margin = revenue - totalCost;
      const marginRate = revenue > 0 ? Math.round(margin / revenue * 1000) / 10 : 0;
      const unitMargin = qty > 0 ? Math.round((revenue / qty) - costPrice) : 0;

      const category = matched ? (matched.category || '') : '';

      return {
        product_name: name,
        product_no: productNo || '',
        matched_inv_name: matchedName,
        category: category,
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
    const s = kstDaysAgo(1);
    const e = kstToday();
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

app.post('/api/db/reset', async (req, res) => {
  try {
    const fs = require('fs');
    const initSqlJs = require('sql.js');
    const dbPath = process.env.RAILWAY_ENVIRONMENT ? '/app/persistent/orders.db' : './data/orders.db';
    // 기존 파일 삭제
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('[DB] 기존 DB 파일 삭제:', dbPath);
    }
    // 메모리 DB도 새로 생성
    const SQL = await initSqlJs();
    orderDB.db = new SQL.Database();
    orderDB._migrate();
    orderDB._persist();
    const newSize = fs.existsSync(dbPath) ? Math.round(fs.statSync(dbPath).size/1024) + 'KB' : '0KB';
    console.log('[DB] 새 DB 생성 완료:', newSize);
    res.json({ success: true, message: 'DB 리셋 완료 (새 DB: ' + newSize + ')' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});
app.get('/api/db/analyze', (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'DB 미준비' });
  try {
    const rawSize = orderDB.db.exec("SELECT SUM(LENGTH(raw_json)) FROM orders")[0]?.values?.[0]?.[0] || 0;
    const nonEmptyRaw = orderDB.db.exec("SELECT COUNT(*) FROM orders WHERE raw_json != '' AND raw_json != '{}'")[0]?.values?.[0]?.[0] || 0;
    const totalRows = orderDB.db.exec("SELECT COUNT(*) FROM orders")[0]?.values?.[0]?.[0] || 0;
    const avgRowSize = totalRows > 0 ? Math.round(rawSize / totalRows) : 0;
    const tableInfo = orderDB.db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values?.map(r=>r[0]) || [];
    res.json({ success: true, data: { totalRows, rawJsonTotalBytes: rawSize, rawJsonMB: Math.round(rawSize/1024/1024), nonEmptyRawRows: nonEmptyRaw, avgRawBytes: avgRowSize, tables: tableInfo } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});


// ═══════════════════════════════════════════════
//  F. 카페24 접속통계(Analytics) API 프록시
// ═══════════════════════════════════════════════
app.get('/api/analytics/:category/:endpoint', async (req, res) => {
  if (!cafe24.tokens?.access_token) return res.json({ success: false, error: '카페24 미인증' });
  try {
    const { category, endpoint } = req.params;
    const { start_date, end_date, device_type, limit, offset, sort, order } = req.query;
    const mallId = cafe24.config.mallId;
    const token = cafe24.tokens.access_token;
    const https = require('https');
    
    let qs = `mall_id=${mallId}&shop_no=1`;
    if (start_date) qs += `&start_date=${start_date}`;
    if (end_date) qs += `&end_date=${end_date}`;
    if (device_type) qs += `&device_type=${device_type}`;
    if (limit) qs += `&limit=${limit}`;
    if (offset) qs += `&offset=${offset}`;
    if (sort) qs += `&sort=${sort}`;
    if (order) qs += `&order=${order}`;
    
    const path = `/${category}/${endpoint}?${qs}`;
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'ca-api.cafe24data.com',
        path: path,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
      };
      const req2 = https.request(opts, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch(e) { resolve({ raw: body.substring(0, 500), status: resp.statusCode }); }
        });
      });
      req2.on('error', reject);
      req2.end();
    });
    res.json({ success: true, data, _path: path });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════
//  Graceful Shutdown (SIGTERM) — 배포 시 DB 안전 저장
// ═══════════════════════════════════════════════
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM 수신 — graceful shutdown...');
  if (dbReady && orderDB) {
    orderDB.shutdown();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT 수신 — graceful shutdown...');
  if (dbReady && orderDB) {
    orderDB.shutdown();
  }
  process.exit(0);
});

module.exports = app;
