/**
 * 쿠팡 Wing API 클라이언트 — HMAC-SHA256 서명 기반 인증
 */
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

class CoupangClient {
  constructor(config = {}) {
    this.config = { vendorId: config.vendorId || '', accessKey: config.accessKey || '', secretKey: config.secretKey || '', ...config };
    this.baseUrl = 'api-gateway.coupang.com';
  }

  _generateSignature(method, path, datetime) {
    return crypto.createHmac('sha256', this.config.secretKey).update(`${datetime}${method}${path}`).digest('hex');
  }

  _getAuthHeader(method, path) {
    const datetime = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const signature = this._generateSignature(method, path, datetime);
    return `CEA algorithm=HmacSHA256, access-key=${this.config.accessKey}, signed-date=${datetime}, signature=${signature}`;
  }

  async _request(method, path, body = null) {
    const auth = this._getAuthHeader(method, path);
    return new Promise((resolve, reject) => {
      const options = { hostname: this.baseUrl, path, method, headers: { 'Authorization': auth, 'Content-Type': 'application/json;charset=UTF-8' } };
      if (body) { const s = JSON.stringify(body); options.headers['Content-Length'] = Buffer.byteLength(s); }
      const req = https.request(options, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => {
          try { const p = JSON.parse(data); if (res.statusCode >= 400) { const e = new Error(p?.message || 'Coupang ' + res.statusCode); e.statusCode = res.statusCode; return reject(e); } resolve(p); }
          catch (e) { reject(new Error('Coupang parse error')); }
        });
      });
      req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
  }

  async getOrders(params = {}) {
    const { status = 'ACCEPT', createdAtFrom, createdAtTo, maxPerPage = 50, nextToken = '' } = params;
    const qs = querystring.stringify({ status, createdAtFrom: createdAtFrom || this._defaultStart(), createdAtTo: createdAtTo || new Date().toISOString(), maxPerPage, ...(nextToken ? { nextToken } : {}) });
    return this._request('GET', `/v2/providers/openapi/apis/api/v1/vendor/A${this.config.vendorId}/ordersheets?${qs}`);
  }

  async getAllOrders(startDate, endDate) {
    const all = []; let nextToken = '', page = 0;
    do {
      const r = await this.getOrders({ createdAtFrom: startDate, createdAtTo: endDate, maxPerPage: 50, nextToken });
      all.push(...(r?.data || [])); nextToken = r?.nextToken || ''; page++;
      if (page >= 200) break;
    } while (nextToken);
    console.log(`[Coupang] ${all.length}건 (${page}p)`); return all;
  }

  async getProducts(params = {}) {
    const { nextToken = '', maxPerPage = 50 } = params;
    const qs = querystring.stringify({ maxPerPage, ...(nextToken ? { nextToken } : {}) });
    return this._request('GET', `/v2/providers/openapi/apis/api/v1/vendor/A${this.config.vendorId}/products?${qs}`);
  }

  async getReturnRequests(params = {}) {
    const qs = querystring.stringify(params);
    return this._request('GET', `/v2/providers/openapi/apis/api/v1/vendor/A${this.config.vendorId}/return-requests?${qs}`);
  }

  async getSalesAnalytics(startDate, endDate) {
    const orders = await this.getAllOrders(startDate, endDate);
    let totalRevenue = 0; const dailySales = {}, productSales = {};
    for (const o of orders) {
      const amt = parseFloat(o.orderPrice || o.totalPrice || 0); totalRevenue += amt;
      const d = (o.orderedAt || o.createdAt || '').substring(0, 10);
      if (d) dailySales[d] = (dailySales[d] || 0) + amt;
      const key = o.vendorItemId || o.vendorItemName || 'unknown';
      if (!productSales[key]) productSales[key] = { productId: o.vendorItemId, productName: o.vendorItemName || key, quantity: 0, revenue: 0 };
      productSales[key].quantity += parseInt(o.shippingCount || 1); productSales[key].revenue += amt;
    }
    return { channel: '쿠팡', period: { startDate, endDate }, totalRevenue, orderCount: orders.length, avgOrderValue: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0, dailySales: Object.entries(dailySales).map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)), topProducts: Object.values(productSales).sort((a, b) => b.revenue - a.revenue).slice(0, 20) };
  }

  _defaultStart() { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString(); }
}

module.exports = CoupangClient;
