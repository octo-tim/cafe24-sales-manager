/**
 * 네이버 커머스 API 클라이언트 (스마트스토어) — OAuth 2.0 Client Credentials
 */
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');

class NaverCommerceClient {
  constructor(config = {}) {
    this.config = { clientId: config.clientId || '', clientSecret: config.clientSecret || '', ...config };
    this.baseUrl = 'api.commerce.naver.com';
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async _ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return;
    const timestamp = Date.now();
    const signature = crypto.createHmac('sha256', this.config.clientSecret).update(`${this.config.clientId}_${timestamp}`).digest('base64');
    const body = querystring.stringify({ client_id: this.config.clientId, timestamp, client_secret_sign: signature, grant_type: 'client_credentials', type: 'SELF' });
    const data = await this._rawRequest({ hostname: this.baseUrl, path: '/external/v1/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 21600) * 1000;
    console.log('[Naver] 토큰 발급 완료');
  }

  async _apiRequest(method, path, body = null) {
    await this._ensureToken();
    const headers = { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' };
    if (body) headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    return this._rawRequest({ hostname: this.baseUrl, path, method, headers, body: body ? JSON.stringify(body) : null });
  }

  _rawRequest(opts) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers }, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => {
          try { const p = JSON.parse(data); if (res.statusCode >= 400) { const e = new Error(p?.message || 'Naver ' + res.statusCode); e.statusCode = res.statusCode; return reject(e); } resolve(p); }
          catch (e) { reject(new Error('Naver parse: ' + data.substring(0, 200))); }
        });
      });
      req.on('error', reject); if (opts.body) req.write(opts.body); req.end();
    });
  }

  async getOrders(params = {}) {
    return this._apiRequest('POST', '/external/v1/pay-order/seller/orders/search', {
      searchType: params.searchType || 'DELIVERED',
      orderDateFrom: params.startDate || this._defaultStart(),
      orderDateTo: params.endDate || this._today(),
    });
  }

  async getAllOrders(startDate, endDate) {
    const statuses = ['PAYED', 'DELIVERED', 'EXCHANGED', 'CANCELED', 'RETURNED'];
    const all = [];
    for (const status of statuses) {
      try {
        const r = await this.getOrders({ searchType: status, startDate, endDate });
        all.push(...(r?.data?.contents || r?.data || []).map(o => ({ ...o, _searchStatus: status })));
      } catch (e) { console.warn(`[Naver] ${status} 실패: ${e.message}`); }
    }
    console.log(`[Naver] ${all.length}건`); return all;
  }

  async getProducts(params = {}) {
    const qs = querystring.stringify({ page: params.page || 1, size: params.size || 100 });
    return this._apiRequest('GET', `/external/v2/products?${qs}`);
  }

  async getSalesAnalytics(startDate, endDate) {
    const orders = await this.getAllOrders(startDate, endDate);
    let totalRevenue = 0; const dailySales = {}, productSales = {};
    for (const o of orders) {
      if (o._searchStatus === 'CANCELED' || o._searchStatus === 'RETURNED') continue;
      const amt = parseFloat(o.totalPaymentAmount || o.paymentAmount || o.totalProductAmount || 0); totalRevenue += amt;
      const d = (o.orderDate || o.paymentDate || '').substring(0, 10);
      if (d) dailySales[d] = (dailySales[d] || 0) + amt;
      const key = o.productOrderId || o.productName || 'unknown';
      if (!productSales[key]) productSales[key] = { productId: o.productId || o.productOrderId, productName: o.productName || key, quantity: 0, revenue: 0 };
      productSales[key].quantity += parseInt(o.quantity || 1); productSales[key].revenue += amt;
    }
    const valid = orders.filter(o => o._searchStatus !== 'CANCELED' && o._searchStatus !== 'RETURNED');
    return { channel: '네이버', period: { startDate, endDate }, totalRevenue, orderCount: valid.length, avgOrderValue: valid.length > 0 ? Math.round(totalRevenue / valid.length) : 0, dailySales: Object.entries(dailySales).map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)), topProducts: Object.values(productSales).sort((a, b) => b.revenue - a.revenue).slice(0, 20) };
  }

  _defaultStart() { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().substring(0, 10); }
  _today() { return new Date().toISOString().substring(0, 10); }
}

module.exports = NaverCommerceClient;
