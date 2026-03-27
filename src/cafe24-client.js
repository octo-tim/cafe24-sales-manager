const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const CONCURRENCY       = 5;
const MIN_DELAY_MS      = 120;
const RATE_LIMIT_DELAY  = 1200;
const PAGE_SIZE         = 100;
const CACHE_TTL_MS      = 60_000;

class Cafe24Client {
  constructor(config = {}) {
    this.config = {
      mallId: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      apiVersion: '2026-03-01',
      tokenStorePath: './tokens.json',
      ...config,
    };
    this.baseUrl = `${this.config.mallId}.cafe24api.com`;
    this.tokens  = this._loadTokens();
    this._bucket = { remaining: 10, limit: 10 };
    this._cache  = new Map();
    this._refreshPromise = null; // 중복 갱신 방지
  }

  // ─── 서버 시작 시 호출: 토큰 자동 복구 ───
  async autoRecover() {
    // 1순위: 메모리(파일)에 토큰이 있으면 유효성 확인
    if (this.tokens?.access_token) {
      const exp = new Date(this.tokens.expires_at);
      if (exp > new Date()) {
        console.log('[Auth] 기존 access_token 유효 (만료: ' + this.tokens.expires_at + ')');
        return true;
      }
      // access_token 만료됨 → refresh 시도
      if (this.tokens.refresh_token) {
        console.log('[Auth] access_token 만료 → refresh_token으로 자동 갱신 시도...');
        try {
          await this.refreshAccessToken();
          console.log('[Auth] 자동 갱신 성공! 새 만료: ' + this.tokens.expires_at);
          return true;
        } catch (e) {
          console.warn('[Auth] refresh 실패: ' + e.message);
        }
      }
    }

    // 2순위: 환경변수에 refresh_token이 있으면 복구
    const envRefresh = process.env.CAFE24_REFRESH_TOKEN;
    if (envRefresh) {
      console.log('[Auth] 환경변수 CAFE24_REFRESH_TOKEN으로 복구 시도...');
      this.tokens = this.tokens || {};
      this.tokens.refresh_token = envRefresh;
      try {
        await this.refreshAccessToken();
        console.log('[Auth] 환경변수 기반 복구 성공! 만료: ' + this.tokens.expires_at);
        return true;
      } catch (e) {
        console.warn('[Auth] 환경변수 기반 복구 실패: ' + e.message);
      }
    }

    // 3순위: 환경변수에 access_token이 직접 있으면 사용
    const envAccess = process.env.CAFE24_ACCESS_TOKEN;
    if (envAccess) {
      console.log('[Auth] 환경변수 CAFE24_ACCESS_TOKEN 직접 사용');
      this.tokens = {
        access_token: envAccess,
        refresh_token: envRefresh || '',
        expires_at: process.env.CAFE24_TOKEN_EXPIRES_AT || new Date(Date.now() + 2 * 3600000).toISOString(),
        refresh_token_expires_at: process.env.CAFE24_REFRESH_EXPIRES_AT || '',
        scopes: [],
      };
      this._saveTokens();
      return true;
    }

    console.log('[Auth] 토큰 없음 → /auth/login 에서 최초 인증 필요');
    return false;
  }

  getAuthorizationUrl(scopes = []) {
    const s = (scopes.length
      ? scopes
      : ['mall.read_order','mall.read_product','mall.read_store','mall.read_supply']
    ).join(',');
    const state = Math.random().toString(36).substring(2, 15);
    return {
      url: `https://${this.baseUrl}/api/v2/oauth/authorize?response_type=code`
        + `&client_id=${this.config.clientId}`
        + `&state=${state}`
        + `&redirect_uri=${encodeURIComponent(this.config.redirectUri)}`
        + `&scope=${encodeURIComponent(s)}`,
      state,
    };
  }

  async getAccessToken(code) {
    const body = querystring.stringify({ grant_type:'authorization_code', code, redirect_uri:this.config.redirectUri });
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    this._logTokenInfo('신규 발급');
    return this.tokens;
  }

  async refreshAccessToken() {
    if (!this.tokens?.refresh_token) throw new Error('refresh_token 없음 → /auth/login 필요');

    // 중복 갱신 방지: 이미 갱신 중이면 기존 Promise 재사용
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      try {
        const body = querystring.stringify({ grant_type:'refresh_token', refresh_token:this.tokens.refresh_token });
        const data = await this._tokenRequest(body);
        this._setTokens(data);
        this._logTokenInfo('갱신');
        return this.tokens;
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  }

  async _ensureValidToken() {
    // access_token 자체가 없는 경우 → refresh 시도
    if (!this.tokens?.access_token) {
      if (this.tokens?.refresh_token || process.env.CAFE24_REFRESH_TOKEN) {
        console.log('[Auth] access_token 없음 → refresh_token으로 자동 복구...');
        if (!this.tokens) this.tokens = {};
        if (!this.tokens.refresh_token) this.tokens.refresh_token = process.env.CAFE24_REFRESH_TOKEN;
        await this.refreshAccessToken();
        return;
      }
      throw new Error('인증 필요: /auth/login 으로 이동하세요');
    }

    // access_token 만료 임박 (5분 전) → 갱신
    const exp = new Date(this.tokens.expires_at);
    if (Date.now() + 300_000 >= exp.getTime()) {
      console.log('[Auth] 토큰 만료 임박 → 자동 갱신...');
      try {
        await this.refreshAccessToken();
      } catch (e) {
        console.error('[Auth] 자동 갱신 실패:', e.message);
        // refresh도 실패하면 환경변수에서 재시도
        if (process.env.CAFE24_REFRESH_TOKEN && process.env.CAFE24_REFRESH_TOKEN !== this.tokens.refresh_token) {
          console.log('[Auth] 환경변수 refresh_token으로 재시도...');
          this.tokens.refresh_token = process.env.CAFE24_REFRESH_TOKEN;
          await this.refreshAccessToken();
        } else {
          throw e;
        }
      }
    }
  }

  // ─── 토큰 정보 로깅 ───
  _logTokenInfo(action) {
    if (!this.tokens) return;
    console.log(`[Auth] ${action} 완료:`);
    console.log(`  access_token:  ${this.tokens.access_token?.substring(0,20)}...`);
    console.log(`  expires_at:    ${this.tokens.expires_at}`);
    console.log(`  refresh_token: ${this.tokens.refresh_token?.substring(0,20)}...`);
    console.log(`  refresh_exp:   ${this.tokens.refresh_token_expires_at || '?'}`);
    console.log(`  ⚠️  Railway Variables에 아래를 저장하면 재배포 후에도 자동 복구됩니다:`);
    console.log(`     CAFE24_REFRESH_TOKEN=${this.tokens.refresh_token}`);
    if (this.tokens.refresh_token_expires_at) {
      console.log(`     CAFE24_REFRESH_EXPIRES_AT=${this.tokens.refresh_token_expires_at}`);
    }
  }

  // ─── 기존 API 메서드 (변경 없음) ───
  async getOrders(params = {}) { return this._get('/api/v2/admin/orders', { limit:50, offset:0, embed:'items', ...params }); }
  async getOrder(id) { return this._get(`/api/v2/admin/orders/${id}`, { embed:'items,receivers,buyer' }); }
  async getOrdersCount(params = {}) { return this._get('/api/v2/admin/orders/count', params); }

  async getAllOrders(startDate, endDate, extraParams = {}) {
    await this._ensureValidToken();
    const baseParams = { start_date:startDate, end_date:endDate, embed:'items', ...extraParams };
    const countRes = await this._get('/api/v2/admin/orders/count', { start_date:startDate, end_date:endDate });
    const total = countRes?.count ?? 0;
    if (total === 0) { console.log('[Cafe24] 주문 0건'); return []; }
    const offsets = [];
    for (let offset = 0; offset < total; offset += PAGE_SIZE) offsets.push(offset);
    console.log(`[Cafe24] 전체 ${total}건 → ${offsets.length}페이지 병렬 fetch`);
    const startTime = Date.now();
    const allPages = await this._parallelPages(offsets, (offset) =>
      this._get('/api/v2/admin/orders', { ...baseParams, limit:PAGE_SIZE, offset })
        .then((r) => r?.orders ?? r?.data?.orders ?? [])
        .catch((e) => { console.error(`[Cafe24] offset=${offset}: ${e.message}`); return []; })
    );
    const flat = allPages.flat();
    console.log(`[Cafe24] ${flat.length}건 완료 (${((Date.now()-startTime)/1000).toFixed(1)}s)`);
    return flat;
  }

  async getProducts(params = {}) { return this._get('/api/v2/admin/products', { limit:100, offset:0, ...params }); }
  async getProduct(no) { return this._get(`/api/v2/admin/products/${no}`, { embed:'variants,inventories' }); }
  async getProductsCount(params = {}) { return this._get('/api/v2/admin/products/count', params); }

  async getAllProducts() {
    await this._ensureValidToken();
    const countRes = await this._get('/api/v2/admin/products/count', {});
    const total = countRes?.count ?? 0;
    if (total === 0) return [];
    const offsets = [];
    for (let offset = 0; offset < total; offset += 100) offsets.push(offset);
    const pages = await this._parallelPages(offsets, (offset) =>
      this._get('/api/v2/admin/products', { limit:100, offset, embed:'variants,inventories' }).then((r) => r?.products ?? []).catch(() => [])
    );
    return pages.flat();
  }

  async getInventory(productNo, variantCode = null) {
    if (variantCode) return this._get(`/api/v2/admin/products/${productNo}/variants/${variantCode}/inventories`);
    return this._get(`/api/v2/admin/products/${productNo}/variants`, { embed:'inventories' });
  }
  async updateInventory(productNo, variantCode, data) { return this._put(`/api/v2/admin/products/${productNo}/variants/${variantCode}/inventories`, { request:data }); }

  async getFullInventoryReport() {
    const products = await this.getAllProducts();
    const report = [];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        const inv = v.inventories || {};
        report.push({ product_no: p.product_no, product_name: p.product_name, variant_code: v.variant_code, option_value: v.option_value || '-', quantity: inv.quantity ?? 0, safety_inventory: inv.safety_inventory ?? 0, use_inventory: inv.use_inventory ?? 'F', selling: p.selling === 'T', display: p.display === 'T' });
      }
    }
    return report;
  }

  async getDashboard() { return this._get('/api/v2/admin/dashboard'); }

  async getSalesAnalytics(startDate, endDate) {
    const orders = await this.getAllOrders(startDate, endDate);
    let totalRevenue = 0;
    const dailySales = {}, productSales = {};
    for (const o of orders) {
      const st = o.order_status || '';
      if (st.startsWith('C') || st.startsWith('R')) continue;
      const amt = parseFloat(o.payment_amount || o.actual_payment_amount || o.total_amount_paid || o.total_price || 0);
      totalRevenue += amt;
      const d = (o.order_date || '').substring(0, 10);
      if (d) dailySales[d] = (dailySales[d] || 0) + amt;
      for (const item of (o.items || [])) {
        const k = item.product_no || item.product_name;
        if (!productSales[k]) productSales[k] = { product_no:item.product_no, product_name:item.product_name, quantity:0, revenue:0 };
        productSales[k].quantity += parseInt(item.quantity || 0);
        productSales[k].revenue += parseFloat(item.product_price || 0) * parseInt(item.quantity || 0);
      }
    }
    const valid = orders.filter((o) => { const s = o.order_status||''; return !s.startsWith('C')&&!s.startsWith('R'); });
    return { period: { startDate, endDate }, totalRevenue, orderCount: valid.length, avgOrderValue: valid.length > 0 ? Math.round(totalRevenue / valid.length) : 0, dailySales: Object.entries(dailySales).map(([date,amount])=>({date,amount})).sort((a,b)=>a.date.localeCompare(b.date)), topProducts: Object.values(productSales).sort((a,b)=>b.revenue-a.revenue).slice(0,20) };
  }

  // ─── 내부 헬퍼 ───
  async _parallelPages(offsets, fetchFn) {
    const results = [];
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      const chunk = offsets.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(chunk.map(fetchFn));
      results.push(...pages);
    }
    return results;
  }

  async _get(ep, params = {}) {
    await this._ensureValidToken();
    const cacheKey = ep + JSON.stringify(params);
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expires) return cached.data;
    const qs = Object.keys(params).length ? '?' + querystring.stringify(params) : '';
    const data = await this._apiRequest({ method:'GET', path:ep+qs });
    this._cache.set(cacheKey, { data, expires:Date.now()+CACHE_TTL_MS });
    return data;
  }

  async _put(ep, body) {
    await this._ensureValidToken();
    return this._apiRequest({ method:'PUT', path:ep, body:JSON.stringify(body) });
  }

  async _apiRequest(opts, retries = 3) {
    if (this._bucket.remaining <= 2) { await this._sleep(Math.max(MIN_DELAY_MS, 1000 / this._bucket.limit * CONCURRENCY * 1.2)); }
    else { await this._sleep(MIN_DELAY_MS); }
    try { return await this._rawRequest(opts); }
    catch (e) {
      // 401 → 토큰 만료, 자동 갱신 후 재시도
      if (e.statusCode === 401 && retries > 0 && this.tokens?.refresh_token) {
        console.warn('[Cafe24] 401 → 토큰 자동 갱신 후 재시도...');
        try {
          await this.refreshAccessToken();
          return this._apiRequest(opts, retries - 1);
        } catch (refreshErr) {
          console.error('[Cafe24] 갱신 실패:', refreshErr.message);
          throw e;
        }
      }
      if (e.statusCode === 429 && retries > 0) { console.warn(`[Cafe24] 429 → ${RATE_LIMIT_DELAY}ms 대기`); await this._sleep(RATE_LIMIT_DELAY); return this._apiRequest(opts, retries - 1); }
      throw e;
    }
  }

  _rawRequest(opts) {
    return new Promise((resolve, reject) => {
      const reqOpts = { hostname: this.baseUrl, path: opts.path, method: opts.method || 'GET', headers: { 'Authorization': `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': this.config.apiVersion } };
      if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
      const req = https.request(reqOpts, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          const lh = res.headers['x-api-call-limit'];
          if (lh) { const [used,total] = lh.split('/').map(Number); this._bucket = { remaining:total-used, limit:total }; }
          try {
            const parsed = JSON.parse(d);
            if (res.statusCode === 429) { const e = new Error('Too Many Requests'); e.statusCode=429; return reject(e); }
            if (res.statusCode >= 400) { const e = new Error(parsed?.error?.message||`API ${res.statusCode}`); e.statusCode=res.statusCode; return reject(e); }
            resolve(parsed);
          } catch (e) { reject(new Error('Parse fail: '+d.substring(0,200))); }
        });
      });
      req.on('error', reject); if (opts.body) req.write(opts.body); req.end();
    });
  }

  async _tokenRequest(body) {
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: this.baseUrl, path:'/api/v2/oauth/token', method:'POST', headers: { 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          try { const p = JSON.parse(d); res.statusCode>=400 ? reject(new Error(`Auth ${res.statusCode}: ${JSON.stringify(p)}`)) : resolve(p); }
          catch (e) { reject(new Error('Auth parse fail')); }
        });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  _setTokens(data) {
    this.tokens = { access_token: data.access_token, expires_at: data.expires_at, refresh_token: data.refresh_token, refresh_token_expires_at: data.refresh_token_expires_at, scopes: data.scopes, issued_at: data.issued_at };
    this._saveTokens();
  }

  _loadTokens() {
    // 1순위: 파일
    try {
      const f = path.resolve(this.config.tokenStorePath);
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (data?.access_token) {
          console.log('[Auth] tokens.json에서 토큰 로드');
          return data;
        }
      }
    } catch(e) {}

    // 2순위: 환경변수
    if (process.env.CAFE24_ACCESS_TOKEN || process.env.CAFE24_REFRESH_TOKEN) {
      console.log('[Auth] 환경변수에서 토큰 로드');
      return {
        access_token: process.env.CAFE24_ACCESS_TOKEN || '',
        refresh_token: process.env.CAFE24_REFRESH_TOKEN || '',
        expires_at: process.env.CAFE24_TOKEN_EXPIRES_AT || '',
        refresh_token_expires_at: process.env.CAFE24_REFRESH_EXPIRES_AT || '',
        scopes: [],
      };
    }

    return null;
  }

  _saveTokens() {
    try { fs.writeFileSync(path.resolve(this.config.tokenStorePath), JSON.stringify(this.tokens,null,2), 'utf8'); }
    catch(e) { console.warn('[Auth] 토큰 파일 저장 실패 (Railway에서는 정상):', e.message); }
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = Cafe24Client;
