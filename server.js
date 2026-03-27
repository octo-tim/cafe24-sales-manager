/**
 * ============================================================
 *  카페24 API 연동 서버
 * ============================================================
 *  - Express 기반 OAuth 콜백 서버
 *  - REST API 엔드포인트 (프론트엔드 대시보드용)
 *  - 스케줄러 기반 자동 데이터 수집
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const Cafe24Client = require('./cafe24-client');

// ─────────────────────────────────────────────
//  환경 설정
// ─────────────────────────────────────────────
const config = {
  mallId: process.env.CAFE24_MALL_ID || 'yourmall',
  clientId: process.env.CAFE24_CLIENT_ID || 'your_client_id',
  clientSecret: process.env.CAFE24_CLIENT_SECRET || 'your_client_secret',
  redirectUri: process.env.CAFE24_REDIRECT_URI || 'http://localhost:3000/auth/callback',
  apiVersion: process.env.CAFE24_API_VERSION || '2024-06-01',
  tokenStorePath: process.env.TOKEN_STORE_PATH || './tokens.json',
};

const cafe24 = new Cafe24Client(config);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (프론트엔드)
app.use(express.static(path.join(__dirname, '..', 'public')));


// ═══════════════════════════════════════════════
//  A. OAuth 인증 라우트
// ═══════════════════════════════════════════════

/**
 * GET /auth/login
 * → 카페24 OAuth 인증 페이지로 리다이렉트
 */
app.get('/auth/login', (req, res) => {
  const { url, state } = cafe24.getAuthorizationUrl();
  // state는 실서비스에서 세션에 저장하여 CSRF 검증에 사용
  console.log(`[Auth] 인증 요청 → state: ${state}`);
  res.redirect(url);
});

/**
 * GET /auth/callback
 * → 카페24에서 인증 코드를 가지고 돌아오는 콜백
 * → Access Token 발급
 */
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({
      success: false,
      error: `인증 실패: ${error}`,
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      error: '인증 코드가 없습니다.',
    });
  }

  try {
    const tokens = await cafe24.getAccessToken(code);
    res.json({
      success: true,
      message: 'Access Token 발급 완료',
      expires_at: tokens.expires_at,
      scopes: tokens.scopes,
    });
  } catch (err) {
    console.error('[Auth] Token 발급 실패:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /auth/status
 * → 현재 토큰 상태 확인
 */
app.get('/auth/status', (req, res) => {
  if (!cafe24.tokens?.access_token) {
    return res.json({ authenticated: false });
  }

  const expiresAt = new Date(cafe24.tokens.expires_at);
  const refreshExpiresAt = new Date(cafe24.tokens.refresh_token_expires_at);

  res.json({
    authenticated: true,
    access_token_expires: cafe24.tokens.expires_at,
    access_token_valid: expiresAt > new Date(),
    refresh_token_expires: cafe24.tokens.refresh_token_expires_at,
    refresh_token_valid: refreshExpiresAt > new Date(),
    scopes: cafe24.tokens.scopes,
  });
});


// ═══════════════════════════════════════════════
//  B. 주문 API 라우트
// ═══════════════════════════════════════════════

/**
 * GET /api/orders
 * 쿼리 파라미터:
 *   ?start_date=2025-03-01
 *   &end_date=2025-03-27
 *   &order_status=N40
 *   &limit=50&offset=0
 */
app.get('/api/orders', async (req, res) => {
  try {
    const result = await cafe24.getOrders(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/orders/all
 * 기간 내 전체 주문 조회 (페이지네이션 자동 처리)
 *   ?start_date=2025-03-01&end_date=2025-03-27
 */
app.get('/api/orders/all', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ success: false, error: 'start_date, end_date 필수' });
    }
    const orders = await cafe24.getAllOrders(start_date, end_date);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/orders/:orderId
 * 주문 상세 조회
 */
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const result = await cafe24.getOrder(req.params.orderId);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/orders/count
 * 주문 건수 조회
 */
app.get('/api/orders-count', async (req, res) => {
  try {
    const result = await cafe24.getOrdersCount(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});


// ═══════════════════════════════════════════════
//  C. 상품 API 라우트
// ═══════════════════════════════════════════════

/**
 * GET /api/products
 * 상품 목록 조회
 */
app.get('/api/products', async (req, res) => {
  try {
    const result = await cafe24.getProducts(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/products/:productNo
 * 상품 상세 (품목 + 재고 포함)
 */
app.get('/api/products/:productNo', async (req, res) => {
  try {
    const result = await cafe24.getProduct(req.params.productNo);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});


// ═══════════════════════════════════════════════
//  D. 재고 API 라우트
// ═══════════════════════════════════════════════

/**
 * GET /api/inventory/:productNo
 * 특정 상품의 품목별 재고 조회
 */
app.get('/api/inventory/:productNo', async (req, res) => {
  try {
    const result = await cafe24.getInventory(req.params.productNo);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * PUT /api/inventory/:productNo/:variantCode
 * 재고 수량 수정
 * Body: { quantity: 100, safety_inventory: 10 }
 */
app.put('/api/inventory/:productNo/:variantCode', async (req, res) => {
  try {
    const { productNo, variantCode } = req.params;
    const result = await cafe24.updateInventory(productNo, variantCode, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/inventory-report
 * 전체 재고 현황 리포트
 */
app.get('/api/inventory-report', async (req, res) => {
  try {
    const report = await cafe24.getFullInventoryReport();
    res.json({ success: true, count: report.length, data: report });
  } catch (err) {
    handleApiError(res, err);
  }
});


// ═══════════════════════════════════════════════
//  E. 매출 분석 API 라우트
// ═══════════════════════════════════════════════

/**
 * GET /api/analytics/sales
 * 기간별 매출 분석
 *   ?start_date=2025-03-01&end_date=2025-03-27
 */
app.get('/api/analytics/sales', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ success: false, error: 'start_date, end_date 필수' });
    }
    const analytics = await cafe24.getSalesAnalytics(start_date, end_date);
    res.json({ success: true, data: analytics });
  } catch (err) {
    handleApiError(res, err);
  }
});

/**
 * GET /api/dashboard
 * 카페24 대시보드 요약 데이터
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const result = await cafe24.getDashboard();
    res.json({ success: true, data: result });
  } catch (err) {
    handleApiError(res, err);
  }
});


// ═══════════════════════════════════════════════
//  F. 스케줄러 (자동 데이터 수집)
// ═══════════════════════════════════════════════

// 매 15분마다 신규 주문 확인
cron.schedule('*/15 * * * *', async () => {
  try {
    console.log('[Scheduler] 신규 주문 수집 시작...');
    const now = new Date();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);

    const result = await cafe24.getOrders({
      start_date: fifteenMinAgo.toISOString().substring(0, 10),
      end_date: now.toISOString().substring(0, 10),
      limit: 100,
      embed: 'items',
    });

    const orders = result.orders || [];
    if (orders.length > 0) {
      console.log(`[Scheduler] ${orders.length}건 신규 주문 감지`);
      // TODO: DB 저장, 알림 발송 등
    }
  } catch (err) {
    console.error('[Scheduler] 주문 수집 실패:', err.message);
  }
});

// 매 1시간마다 재고 동기화
cron.schedule('0 * * * *', async () => {
  try {
    console.log('[Scheduler] 재고 동기화 시작...');
    const report = await cafe24.getFullInventoryReport();

    // 안전 재고 이하 품목 경고
    const lowStock = report.filter(
      (item) => item.use_inventory === 'T' && item.quantity <= item.safety_inventory
    );

    if (lowStock.length > 0) {
      console.warn(`[Scheduler] ⚠️ 안전재고 이하 ${lowStock.length}건:`);
      lowStock.forEach((item) => {
        console.warn(`  - ${item.product_name} [${item.option_value}]: ${item.quantity}개`);
      });
      // TODO: 알림 발송 (이메일, Slack 등)
    }
  } catch (err) {
    console.error('[Scheduler] 재고 동기화 실패:', err.message);
  }
});


// ─────────────────────────────────────────────
//  에러 핸들러
// ─────────────────────────────────────────────
function handleApiError(res, err) {
  console.error('[API Error]', err.message);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: err.message,
  });
}


// ─────────────────────────────────────────────
//  서버 시작
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  카페24 판매관리 API 서버                              ║
║  http://localhost:${PORT}                                ║
╠═══════════════════════════════════════════════════════╣
║  인증:  GET /auth/login                               ║
║  콜백:  GET /auth/callback                            ║
║  상태:  GET /auth/status                              ║
╠═══════════════════════════════════════════════════════╣
║  주문:  GET /api/orders                               ║
║  상품:  GET /api/products                             ║
║  재고:  GET /api/inventory/:productNo                 ║
║  분석:  GET /api/analytics/sales                      ║
╚═══════════════════════════════════════════════════════╝
  `);

  // 기존 토큰이 있으면 상태 확인
  if (cafe24.tokens?.access_token) {
    const expiresAt = new Date(cafe24.tokens.expires_at);
    if (expiresAt > new Date()) {
      console.log(`[Auth] 기존 토큰 유효 (만료: ${cafe24.tokens.expires_at})`);
    } else {
      console.log('[Auth] 기존 토큰 만료됨 → /auth/login 에서 재인증 필요');
    }
  } else {
    console.log('[Auth] 토큰 없음 → http://localhost:' + PORT + '/auth/login 에서 인증하세요');
  }
});

module.exports = app;
