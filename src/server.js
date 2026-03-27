/**
 * ============================================================
 *  카페24 판매관리 시스템 v2.1 — 멀티채널 통합 + 주문수집
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

const config = {
  cafe24: { mallId: process.env.CAFE24_MALL_ID || 'yourmall', clientId: process.env.CAFE24_CLIENT_ID || '', clientSecret: process.env.CAFE24_CLIENT_SECRET || '', redirectUri: process.env.CAFE24_REDIRECT_URI || 'http://localhost:3000/auth/callback', apiVersion: process.env.CAFE24_API_VERSION || '2026-03-01', tokenStorePath: process.env.TOKEN_STORE_PATH || './tokens.json' },
  coupang: { vendorId: process.env.COUPANG_VENDOR_ID || '', accessKey: process.env.COUPANG_ACCESS_KEY || '', secretKey: process.env.COUPANG_SECRET_KEY || '' },
  naver: { clientId: process.env.NAVER_COMMERCE_CLIENT_ID || '', clientSecret: process.env.NAVER_COMMERCE_CLIENT_SECRET || '' },
};

const cafe24 = new Cafe24Client(config.cafe24);
const coupang = config.coupang.accessKey ? new CoupangClient(config.coupang) : null;
const naver = config.naver.clientId ? new NaverCommerceClient(config.naver) : null;
const multiChannel = new MultiChannelService({ cafe24Client: cafe24, coupangClient: coupang, naverClient: naver });

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const MAX_COLLECT_DAYS = 30;

// ═══════════════════════════════════════════════
//  주문 수집 엔진 (Order Collector)
// ═══════════════════════════════════════════════

const collector = {
  history: [],
  maxHistory: 50,
  isRunning: false,
  lastRun: null,

  async collectChannel(channelName, fetchFn) {
    const start = Date.now();
    try {
      const orders = await fetchFn();
      const count = Array.isArray(orders) ? orders.length : (orders?.orders?.length || orders?.data?.length || 0);
      return { channel: channelName, status: 'success', count, latency: Date.now() - start };
    } catch (e) {
      return { channel: channelName, status: 'error', error: e.message, count: 0, latency: Date.now() - start };
    }
  },

  /**
   * 전체 채널 주문 수집
   * @param {string} trigger - 'auto' | 'manual'
   * @param {number} days - 수집 기간 (일). 1~30일. 기본 1일.
   * @param {string} startDate - 직접 지정 시작일 (YYYY-MM-DD). days보다 우선.
   * @param {string} endDate - 직접 지정 종료일 (YYYY-MM-DD).
   */
  async collectAll(trigger = 'auto', { days = 1, startDate, endDate } = {}) {
    if (this.isRunning) {
      return { success: false, error: '수집이 이미 진행 중입니다.', isRunning: true };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const now = new Date();

    // 기간 계산: 직접 지정 > days 파라미터
    let collectStart, collectEnd;
    if (startDate && endDate) {
      collectStart = startDate;
      collectEnd = endDate;
      // 최대 30일 제한 검증
      const diffMs = new Date(endDate) - new Date(startDate);
      const diffDays = Math.ceil(diffMs / 86400000);
      if (diffDays > MAX_COLLECT_DAYS) {
        this.isRunning = false;
        return { success: false, error: `최대 ${MAX_COLLECT_DAYS}일까지만 수집 가능합니다. (요청: ${diffDays}일)` };
      }
      if (diffDays < 0) {
        this.isRunning = false;
        return { success: false, error: '시작일이 종료일보다 이후입니다.' };
      }
    } else {
      const clampedDays = Math.max(1, Math.min(days, MAX_COLLECT_DAYS));
      const fromDate = new Date(now.getTime() - clampedDays * 86400000);
      collectStart = fromDate.toISOString().substring(0, 10);
      collectEnd = now.toISOString().substring(0, 10);
    }

    const periodDays = Math.ceil((new Date(collectEnd) - new Date(collectStart)) / 86400000) || 1;

    console.log(`[Collector] ${trigger === 'manual' ? '수동' : '자동'} 주문 수집 (${collectStart} ~ ${collectEnd}, ${periodDays}일)`);

    const results = await Promise.allSettled([
      // 카페24: getAllOrders로 전체 페이지네이션 처리
      this.collectChannel('카페24', async () => {
        if (!cafe24.tokens?.access_token) throw new Error('미인증');
        if (periodDays <= 1) {
          return cafe24.getOrders({ start_date: collectStart, end_date: collectEnd, limit: 100, embed: 'items' });
        }
        // 기간이 길면 getAllOrders 사용 (병렬 페이징)
        const orders = await cafe24.getAllOrders(collectStart, collectEnd);
        return { orders };
      }),
      // 쿠팡
      this.collectChannel('쿠팡', async () => {
        if (!coupang) throw new Error('미설정');
        if (periodDays <= 1) {
          return coupang.getOrders({
            createdAtFrom: new Date(collectStart).toISOString(),
            createdAtTo: new Date(collectEnd + 'T23:59:59').toISOString(),
            maxPerPage: 50
          });
        }
        const orders = await coupang.getAllOrders(
          new Date(collectStart).toISOString(),
          new Date(collectEnd + 'T23:59:59').toISOString()
        );
        return { data: orders };
      }),
      // 네이버
      this.collectChannel('네이버', async () => {
        if (!naver) throw new Error('미설정');
        if (periodDays <= 1) {
          return naver.getOrders({ searchType: 'PAYED', startDate: collectStart, endDate: collectEnd });
        }
        const orders = await naver.getAllOrders(collectStart, collectEnd);
        return { data: orders };
      }),
    ]);

    const channels = results.map(r => r.status === 'fulfilled' ? r.value : { channel: '?', status: 'error', error: r.reason?.message || '알 수 없는 오류', count: 0, latency: 0 });
    const totalCount = channels.reduce((s, c) => s + c.count, 0);
    const totalLatency = Date.now() - startTime;

    const record = {
      id: Date.now().toString(36),
      trigger,
      timestamp: now.toISOString(),
      duration: totalLatency,
      period: { start: collectStart, end: collectEnd, days: periodDays },
      totalCount,
      channels,
    };

    this.history.unshift(record);
    if (this.history.length > this.maxHistory) this.history.pop();
    this.lastRun = record;
    this.isRunning = false;

    console.log(`[Collector] 완료: ${totalCount}건 (${totalLatency}ms) [${collectStart}~${collectEnd}] — ${channels.map(c => `${c.channel}:${c.count}`).join(', ')}`);
    return { success: true, data: record };
  },

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      historyCount: this.history.length,
      maxDays: MAX_COLLECT_DAYS,
      schedule: '*/30 * * * *',
      scheduleDesc: '30분마다',
      channels: {
        카페24: { configured: !!config.cafe24.clientId, authenticated: !!cafe24.tokens?.access_token },
        쿠팡: { configured: !!config.coupang.accessKey },
        네이버: { configured: !!config.naver.clientId },
      },
    };
  },
};


// ═══════════════════════════════════════════════
//  A. OAuth (카페24)
// ═══════════════════════════════════════════════
app.get('/auth/login', (req, res) => { const { url, state } = cafe24.getAuthorizationUrl(); console.log(`[Auth] state: ${state}`); res.redirect(url); });
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ success: false, error: `인증 실패: ${error}` });
  if (!code) return res.status(400).json({ success: false, error: '인증 코드 없음' });
  try {
      const tokens = await cafe24.getAccessToken(code);
      console.log('[Auth] ===== 인증 성공 =====');
      console.log('[Auth] Railway Variables에 저장하세요:');
      console.log('  CAFE24_REFRESH_TOKEN=' + tokens.refresh_token);
      if (tokens.refresh_token_expires_at) console.log('  CAFE24_REFRESH_EXPIRES_AT=' + tokens.refresh_token_expires_at);
      console.log('[Auth] ======================');
      res.redirect('/?auth=success');
    }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/auth/status', (req, res) => {
  const channels = [];
  if (cafe24.tokens?.access_token) { const exp = new Date(cafe24.tokens.expires_at); channels.push({ channel: '카페24', authenticated: true, valid: exp > new Date(), expires: cafe24.tokens.expires_at }); }
  else { channels.push({ channel: '카페24', authenticated: false }); }
  channels.push({ channel: '쿠팡', authenticated: !!config.coupang.accessKey, valid: !!config.coupang.accessKey, type: 'HMAC' });
  channels.push({ channel: '네이버', authenticated: !!config.naver.clientId, valid: !!config.naver.clientId, type: 'OAuth2-CC' });
  res.json({ success: true, channels });
});


// ═══════════════════════════════════════════════
//  B~E. 기존 API 라우트 (카페24/쿠팡/네이버/멀티채널)
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
app.get('/api/coupang/analytics/sales', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await coupang.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/orders', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/products', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/analytics/sales', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await naver.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });
app.use('/api/multichannel', multiChannelRouter(multiChannel));


// ═══════════════════════════════════════════════
//  F. 주문 수집 API (/api/collector/*)
// ═══════════════════════════════════════════════

/**
 * POST /api/collector/run — 수동 주문수집
 * Body: { days: 7 }               → 최근 7일 수집
 * Body: { days: 30 }              → 최근 30일 수집 (최대)
 * Body: { start_date, end_date }  → 직접 기간 지정 (최대 30일)
 * Body: {} (없음)                 → 기본 최근 1일
 */
app.post('/api/collector/run', async (req, res) => {
  try {
    const { days, start_date, end_date } = req.body || {};
    const result = await collector.collectAll('manual', {
      days: days || 1,
      startDate: start_date,
      endDate: end_date,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/collector/status', (req, res) => {
  res.json({ success: true, data: collector.getStatus() });
});

app.get('/api/collector/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json({ success: true, data: collector.history.slice(0, limit) });
});

app.get('/api/collector/last', (req, res) => {
  res.json({ success: true, data: collector.lastRun });
});


// ═══════════════════════════════════════════════
//  G. 설정 상태
// ═══════════════════════════════════════════════
app.get('/api/config/status', (req, res) => {
  res.json({ success: true, data: {
    cafe24: { configured: !!config.cafe24.clientId, mallId: config.cafe24.mallId, authenticated: !!cafe24.tokens?.access_token },
    coupang: { configured: !!config.coupang.accessKey },
    naver: { configured: !!config.naver.clientId },
  }});
});


// ═══════════════════════════════════════════════
//  H. 스케줄러
// ═══════════════════════════════════════════════

// 30분마다 — 최근 1일치 주문 수집
cron.schedule('*/30 * * * *', async () => {
  console.log('[Scheduler] 30분 주기 주문 수집...');
  await collector.collectAll('auto', { days: 1 });
});

// 매 시간 — 일간 매출 스냅샷
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const s = new Date(now.getTime() - 86400000).toISOString().substring(0, 10);
    const e = now.toISOString().substring(0, 10);
    const a = await multiChannel.getIntegratedSalesAnalytics(s, e);
    console.log(`[Scheduler] 일간 매출: ${Math.round(a.summary.totalRevenue).toLocaleString()}원 (${a.summary.totalOrders}건)`);
  } catch (e) { console.error('[Scheduler]', e.message); }
});

function handleApiError(res, err) { console.error('[API]', err.message); res.status(err.statusCode || 500).json({ success: false, error: err.message }); }

app.get('/api/debug/test', async (req, res) => {
  try { const https = require('https'); const token = cafe24.tokens ? cafe24.tokens.access_token : null; const mallId = cafe24.config.mallId; const ver = cafe24.config.apiVersion; const result = await new Promise((resolve, reject) => { const o = { hostname: mallId + '.cafe24api.com', path: '/api/v2/admin/orders?limit=1', method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': ver } }; const r = https.request(o, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d.substring(0, 2000), req: { host: o.hostname, path: o.path, version: ver, token: token ? token.substring(0, 15) + '...' : 'null' } })); }); r.on('error', reject); r.end(); }); res.json(result); }
  catch (e) { res.json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  카페24 판매관리 v2.1 — http://localhost:${PORT}`);
  console.log(`  카페24: ${cafe24.tokens?.access_token ? '인증됨' : '미인증'} | 쿠팡: ${coupang ? '설정됨' : '미설정'} | 네이버: ${naver ? '설정됨' : '미설정'}`);
  console.log(`  주문 수집: 30분 자동(1일) + 수동 최대 ${MAX_COLLECT_DAYS}일\n`);
});

module.exports = app;
