/**
 * ============================================================
 *  카페24 판매관리 시스템 v2.0 — 멀티채널 통합 서버
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

// A. OAuth (카페24)
app.get('/auth/login', (req, res) => { const { url, state } = cafe24.getAuthorizationUrl(); console.log(`[Auth] state: ${state}`); res.redirect(url); });
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ success: false, error: `인증 실패: ${error}` });
  if (!code) return res.status(400).json({ success: false, error: '인증 코드 없음' });
  try { await cafe24.getAccessToken(code); res.redirect('/?auth=success'); }
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

// B. 카페24 API
app.get('/api/orders', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders/all', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, count: (await cafe24.getAllOrders(start_date, end_date)).length, data: await cafe24.getAllOrders(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders/:orderId', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrder(req.params.orderId) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/orders-count', async (req, res) => { try { res.json({ success: true, data: await cafe24.getOrdersCount(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/products', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/products/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getProduct(req.params.productNo) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/inventory/:productNo', async (req, res) => { try { res.json({ success: true, data: await cafe24.getInventory(req.params.productNo) }); } catch (err) { handleApiError(res, err); } });
app.put('/api/inventory/:productNo/:variantCode', async (req, res) => { try { res.json({ success: true, data: await cafe24.updateInventory(req.params.productNo, req.params.variantCode, req.body) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/inventory-report', async (req, res) => { try { const r = await cafe24.getFullInventoryReport(); res.json({ success: true, count: r.length, data: r }); } catch (err) { handleApiError(res, err); } });
app.get('/api/analytics/sales', async (req, res) => { try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await cafe24.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/dashboard', async (req, res) => { try { res.json({ success: true, data: await cafe24.getDashboard() }); } catch (err) { handleApiError(res, err); } });

// C. 쿠팡 API
app.get('/api/coupang/orders', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { res.json({ success: true, data: await coupang.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/coupang/products', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { res.json({ success: true, data: await coupang.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/coupang/analytics/sales', async (req, res) => { if (!coupang) return res.status(400).json({ success: false, error: '쿠팡 미설정' }); try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await coupang.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });

// D. 네이버 API
app.get('/api/naver/orders', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getOrders(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/products', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { res.json({ success: true, data: await naver.getProducts(req.query) }); } catch (err) { handleApiError(res, err); } });
app.get('/api/naver/analytics/sales', async (req, res) => { if (!naver) return res.status(400).json({ success: false, error: '네이버 미설정' }); try { const { start_date, end_date } = req.query; if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' }); res.json({ success: true, data: await naver.getSalesAnalytics(start_date, end_date) }); } catch (err) { handleApiError(res, err); } });

// E. 멀티채널 통합
app.use('/api/multichannel', multiChannelRouter(multiChannel));

// F. 설정 상태
app.get('/api/config/status', (req, res) => {
  res.json({ success: true, data: {
    cafe24: { configured: !!config.cafe24.clientId, mallId: config.cafe24.mallId, authenticated: !!cafe24.tokens?.access_token },
    coupang: { configured: !!config.coupang.accessKey },
    naver: { configured: !!config.naver.clientId },
  }});
});

// G. 스케줄러
cron.schedule('*/15 * * * *', async () => {
  try { const now = new Date(); const ago = new Date(now.getTime() - 15 * 60000); const r = await cafe24.getOrders({ start_date: ago.toISOString().substring(0, 10), end_date: now.toISOString().substring(0, 10), limit: 100, embed: 'items' }); if ((r.orders || []).length > 0) console.log(`[Cron] 카페24 ${r.orders.length}건`); }
  catch (e) { console.error('[Cron]', e.message); }
});
cron.schedule('0 * * * *', async () => {
  try { const now = new Date(); const s = new Date(now.getTime() - 86400000).toISOString().substring(0, 10); const e = now.toISOString().substring(0, 10); const a = await multiChannel.getIntegratedSalesAnalytics(s, e); console.log(`[Cron] 일간: ${Math.round(a.summary.totalRevenue).toLocaleString()}원`); }
  catch (e) { console.error('[Cron]', e.message); }
});

function handleApiError(res, err) { console.error('[API]', err.message); res.status(err.statusCode || 500).json({ success: false, error: err.message }); }

app.get('/api/debug/test', async (req, res) => {
  try { const https = require('https'); const token = cafe24.tokens ? cafe24.tokens.access_token : null; const mallId = cafe24.config.mallId; const ver = cafe24.config.apiVersion; const result = await new Promise((resolve, reject) => { const o = { hostname: mallId + '.cafe24api.com', path: '/api/v2/admin/orders?limit=1', method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': ver } }; const r = https.request(o, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d.substring(0, 2000), req: { host: o.hostname, path: o.path, version: ver, token: token ? token.substring(0, 15) + '...' : 'null' } })); }); r.on('error', reject); r.end(); }); res.json(result); }
  catch (e) { res.json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  카페24 판매관리 v2.0 — http://localhost:${PORT}`);
  console.log(`  카페24: ${cafe24.tokens?.access_token ? '인증됨' : '미인증'} | 쿠팡: ${coupang ? '설정됨' : '미설정'} | 네이버: ${naver ? '설정됨' : '미설정'}\n`);
});

module.exports = app;
