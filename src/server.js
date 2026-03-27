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
  cafe24: { mallId: process.env.CAFE24_MALL_ID || 'yourmall', clientId: process.env.CAFE24_CLIENT_ID || '', clientSecret: process.env.CAFE24_CLIENT_SECRET || '', redirectUri: process.env.CAFE24_REDIRECT_URI || 'http://localhost:3000/auth/callback', apiVersion: process.env.CAFE24_API_VERSION || '2026-03-01', tokenStorePath: process.env.TOKEN_STORE_PATH || './tokens.json' },
  coupang: { vendorId: process.env.COUPANG_VENDOR_ID || '', accessKey: process.env.COUPANG_ACCESS_KEY || '', secretKey: process.env.COUPANG_SECRET_KEY || '' },
  naver: { clientId: process.env.NAVER_COMMERCE_CLIENT_ID || '', clientSecret: process.env.NAVER_COMMERCE_CLIENT_SECRET || '' },
};

const cafe24 = new Cafe24Client(config.cafe24);
const coupang = config.coupang.accessKey ? new CoupangClient(config.coupang) : null;
const naver = config.naver.clientId ? new NaverCommerceClient(config.naver) : null;
const multiChannel = new MultiChannelService({ cafe24Client: cafe24, coupangClient: coupang, naverClient: naver });
const orderDB = new OrderDB();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const MAX_COLLECT_DAYS = 30;

// ═══════════════════════════════════════════════
//  주문 수집 엔진 — DB 저장 통합
// ═══════════════════════════════════════════════

const collector = {
  isRunning: false,
  lastRun: null,

  async collectChannel(channelName, fetchFn) {
    const start = Date.now();
    try {
      const result = await fetchFn();
      const orders = Array.isArray(result) ? result : (result?.orders || result?.data || []);
      // DB에 저장
      const saveResult = orderDB.saveOrders(channelName, orders);
      console.log(`[Collector] ${channelName}: ${orders.length}건 수집 → DB ${saveResult.inserted}건 저장`);
      return { channel: channelName, status: 'success', count: orders.length, saved: saveResult.inserted, latency: Date.now() - start };
    } catch (e) {
      return { channel: channelName, status: 'error', error: e.message, count: 0, saved: 0, latency: Date.now() - start };
    }
  },

  async collectAll(trigger = 'auto', { days = 1, startDate, endDate } = {}) {
    if (this.isRunning) return { success: false, error: '수집이 이미 진행 중입니다.', isRunning: true };

    this.isRunning = true;
    const startTime = Date.now();
    const now = new Date();

    let collectStart, collectEnd;
    if (startDate && endDate) {
      collectStart = startDate; collectEnd = endDate;
      const diffDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);
      if (diffDays > MAX_COLLECT_DAYS) { this.isRunning = false; return { success: false, error: `최대 ${MAX_COLLECT_DAYS}일까지만 수집 가능합니다.` }; }
      if (diffDays < 0) { this.isRunning = false; return { success: false, error: '시작일이 종료일보다 이후입니다.' }; }
    } else {
      const clampedDays = Math.max(1, Math.min(days, MAX_COLLECT_DAYS));
      const fromDate = new Date(now.getTime() - clampedDays * 86400000);
      collectStart = fromDate.toISOString().substring(0, 10);
      collectEnd = now.toISOString().substring(0, 10);
    }

    const periodDays = Math.ceil((new Date(collectEnd) - new Date(collectStart)) / 86400000) || 1;
    console.log(`[Collector] ${trigger === 'manual' ? '수동' : '자동'} 수집 (${collectStart} ~ ${collectEnd}, ${periodDays}일)`);

    const results = await Promise.allSettled([
      this.collectChannel('카페24', async () => {
        if (!cafe24.tokens?.access_token) throw new Error('미인증');
        return cafe24.getAllOrders(collectStart, collectEnd);
      }),
      this.collectChannel('쿠팡', async () => {
        if (!coupang) throw new Error('미설정');
        return coupang.getAllOrders(new Date(collectStart).toISOString(), new Date(collectEnd + 'T23:59:59').toISOString());
      }),
      this.collectChannel('네이버', async () => {
        if (!naver) throw new Error('미설정');
        return naver.getAllOrders(collectStart, collectEnd);
      }),
    ]);

    const channels = results.map(r => r.status === 'fulfilled' ? r.value : { channel: '?', status: 'error', error: r.reason?.message || '오류', count: 0, saved: 0, latency: 0 });
    const totalCount = channels.reduce((s, c) => s + c.count, 0);
    const totalSaved = channels.reduce((s, c) => s + (c.saved || 0), 0);

    const record = {
      trigger, timestamp: now.toISOString(), duration: Date.now() - startTime,
      period: { start: collectStart, end: collectEnd, days: periodDays },
      totalCount, totalSaved, channels,
    };

    // DB에 수집 이력 저장
    orderDB.saveCollectHistory(record);
    this.lastRun = record;
    this.isRunning = false;

    console.log(`[Collector] 완료: ${totalCount}건 수집 / ${totalSaved}건 DB 저장 (${record.duration}ms)`);
    return { success: true, data: record };
  },

  getStatus() {
    const dbStats = orderDB.getStats();
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      maxDays: MAX_COLLECT_DAYS,
      schedule: '*/30 * * * *',
      scheduleDesc: '30분마다',
      db: dbStats,
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
app.get('/auth/login', (req, res) => { const { url, state } = cafe24.getAuthorizationUrl(); res.redirect(url); });
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ success: false, error: `인증 실패: ${error}` });
  if (!code) return res.status(400).json({ success: false, error: '인증 코드 없음' });
  try {
    const tokens = await cafe24.getAccessToken(code);
    console.log('[Auth] 인증 성공 — CAFE24_REFRESH_TOKEN=' + tokens.refresh_token);
    res.redirect('/?auth=success');
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/auth/status', (req, res) => {
  const channels = [];
  if (cafe24.tokens?.access_token) { const exp = new Date(cafe24.tokens.expires_at); channels.push({ channel: '카페24', authenticated: true, valid: exp > new Date(), expires: cafe24.tokens.expires_at }); }
  else channels.push({ channel: '카페24', authenticated: false });
  channels.push({ channel: '쿠팡', authenticated: !!config.coupang.accessKey, valid: !!config.coupang.accessKey, type: 'HMAC' });
  channels.push({ channel: '네이버', authenticated: !!config.naver.clientId, valid: !!config.naver.clientId, type: 'OAuth2-CC' });
  res.json({ success: true, channels });
});


// ═══════════════════════════════════════════════
//  B. 카페24/쿠팡/네이버 API (기존 유지)
// ═══════════════════════════════════════════════
app.get('/api/orders', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders/all', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); const orders = await cafe24.getAllOrders(start_date, end_date); res.json({ success: true, count: orders.length, data: orders }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders/:orderId', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrder(req.params.orderId) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders-count', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrdersCount(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/products', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/products/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProduct(req.params.productNo) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/inventory/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getInventory(req.params.productNo) }); } catch (err) { handleApiError(res, err); } });
app.put('/api/inventory/:productNo/:variantCode', async (req, res) => { try { res.json({ success: true, data: await cafe24.updateInventory(req.params.productNo, req.params.variantCode, req.body) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/inventory-report', async (req, res) => { try { const r = await cafe24.getFullInventoryReport(); res.json({ success: true, count: r.length, data: r }); } catch (err) { handleApiError(res, err); } });
app.get('/api/analytics/sales', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await cafe24.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/dashboard', async (req, res) => { try { res.json({ success: true, data: await cafe24.getDashboard() }); } catch (err) { handleApiError(res, err); } });
app.get('/api/coupang/orders', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { res.json({ success: true, data: await coupang.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/coupang/products', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { res.json({ success: true, data: await coupang.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/orders', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/products', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.use('/api/multichannel', multiChannelRouter(multiChannel));


// ═══════════════════════════════════════════════
//  C. DB 기반 고속 조회 API (/api/db/*)
// ═══════════════════════════════════════════════

/** DB 대시보드 — 즉시 반환 */
app.get('/api/db/dashboard', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 86400000).toISOString().substring(0, 10);
    const endDate = now.toISOString().substring(0, 10);
    const data = orderDB.getDashboardData(startDate, endDate);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** DB 매출 요약 */
app.get('/api/db/sales', (req, res) => {
  try {
    const { start_date, end_date, channel } = req.query;
    if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' });
    const summary = orderDB.getSalesSummary(start_date, end_date);
    const daily = orderDB.getDailySales(start_date, end_date, channel);
    const topProducts = orderDB.getTopProducts(start_date, end_date);
    res.json({ success: true, data: { summary, daily, topProducts, fromDB: true } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** DB 최근 주문 목록 */
app.get('/api/db/orders', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const channel = req.query.channel;
    const orders = orderDB.getRecentOrders(limit, channel);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/** DB 통계 */
app.get('/api/db/stats', (req, res) => {
  try {
    const stats = orderDB.getStats();
    res.json({ success: true, data: stats });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ═══════════════════════════════════════════════
//  D. 주문 수집 API
// ═══════════════════════════════════════════════

app.post('/api/collector/run', async (req, res) => {
  try {
    const { days, start_date, end_date } = req.body || {};
    const result = await collector.collectAll('manual', { days: days || 1, startDate: start_date, endDate: end_date });
    res.json(result);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/collector/status', (req, res) => {
  res.json({ success: true, data: collector.getStatus() });
});

app.get('/api/collector/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const history = orderDB.getCollectHistory(limit);
    res.json({ success: true, data: history });
  } catch (err) { res.json({ success: true, data: [] }); }
});

app.get('/api/collector/last', (req, res) => {
  res.json({ success: true, data: collector.lastRun });
});


// ═══════════════════════════════════════════════
//  E. 설정/스케줄러/에러처리
// ═══════════════════════════════════════════════

app.get('/api/config/status', (req, res) => {
  const dbStats = orderDB.getStats();
  res.json({ success: true, data: {
    cafe24: { configured: !!config.cafe24.clientId, mallId: config.cafe24.mallId, authenticated: !!cafe24.tokens?.access_token },
    coupang: { configured: !!config.coupang.accessKey },
    naver: { configured: !!config.naver.clientId },
    db: dbStats,
  }});
});

// 30분마다 자동 수집
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] 30분 주기 주문 수집...');
  await collector.collectAll('auto', { days: 1 });
});

// 매 시간 매출 스냅샷 로그
cron.schedule('0 * * * *', () => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 86400000).toISOString().substring(0, 10);
    const end = now.toISOString().substring(0, 10);
    const summary = orderDB.getSalesSummary(start, end);
    const total = summary.reduce((s, r) => s + r.total_amount, 0);
    console.log(`[Cron] 일간 DB 매출: ${Math.round(total).toLocaleString()}원 (${summary.reduce((s,r)=>s+r.order_count,0)}건)`);
  } catch (e) { console.error('[Cron]', e.message); }
});

function handleApiError(res, err) { console.error('[API]', err.message); res.status(err.statusCode || 500).json({ success: false, error: err.message }); }

app.get('/api/debug/test', async (req, res) => {
  try {
    const https = require('https'); const token = cafe24.tokens ? cafe24.tokens.access_token : null;
    const mallId = cafe24.config.mallId; const ver = cafe24.config.apiVersion;
    const result = await new Promise((resolve, reject) => {
      const o = { hostname: mallId + '.cafe24api.com', path: '/api/v2/admin/orders?limit=1', method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': ver } };
      const r = https.request(o, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d.substring(0, 2000) })); });
      r.on('error', reject); r.end();
    });
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

// 서버 시작 시 카페24 토큰 복구
cafe24.autoRecover().then(ok => {
  if (ok) console.log('[Boot] 카페24 토큰 복구 성공');
  else console.log('[Boot] 카페24 미인증');
}).catch(e => console.error('[Boot]', e.message));

app.listen(PORT, '0.0.0.0', () => {
  const dbStats = orderDB.getStats();
  console.log(`\n  카페24 판매관리 v2.2 — http://localhost:${PORT}`);
  console.log(`  카페24: ${cafe24.tokens?.access_token ? '인증됨' : '미인증'} | 쿠팡: ${coupang ? '설정됨' : '미설정'} | 네이버: ${naver ? '설정됨' : '미설정'}`);
  console.log(`  DB: ${dbStats.totalOrders}건 저장 (${dbStats.dbSize}) | 30분 자동수집\n`);
});

module.exports = app;
