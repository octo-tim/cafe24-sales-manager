const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const CONCURRENCY       = 5;
const MIN_DELAY_MS      = 120;
const RATE_LIMIT_DELAY  = 1200;
const PAGE_SIZE         = 500;
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
    this._refreshPromise = null;
    this._orderDB = null; // server.js에서 주입
  }

  /** server.js에서 DB 인스턴스 주입 (토큰 영구 저장용) */
  setDB(orderDB) {
    this._orderDB = orderDB;
  }

  // ─── 서버 시작 시 토큰 자동 복구 ───
  async autoRecover() {
    // 1순위: 메모리/파일에 유효한 토큰
    if (this.tokens?.access_token) {
      const exp = new Date(this.tokens.expires_at);
      if (exp > new Date()) {
        console.log('[Auth] 기존 access_token 유효 (만료: ' + this.tokens.expires_at + ')');
        return true;
      }
      if (this.tokens.refresh_token) {
        console.log('[Auth] access_token 만료 → refresh 갱신...');
        try { await this.refreshAccessToken(); return true; }
        catch (e) { console.warn('[Auth] refresh 실패:', e.message); }
      }
    }

    // 2순위: DB에 저장된 최신 refresh_token
    const dbToken = this._loadTokenFromDB();
    if (dbToken?.refresh_token) {
      console.log('[Auth] DB에서 refresh_token 복구...');
      this.tokens = this.tokens || {};
      this.tokens.refresh_token = dbToken.refresh_token;
      try { await this.refreshAccessToken(); console.log('[Auth] DB 기반 복구 성공!'); return true; }
      catch (e) { console.warn('[Auth] DB 기반 복구 실패:', e.message); }
    }

    // 3순위: 환경변수 CAFE24_REFRESH_TOKEN (최초 1회 설정용)
    const envRefresh = process.env.CAFE24_REFRESH_TOKEN;
    if (envRefresh) {
      console.log('[Auth] 환경변수 CAFE24_REFRESH_TOKEN으로 복구...');
      this.tokens = this.tokens || {};
      this.tokens.refresh_token = envRefresh;
      try { await this.refreshAccessToken(); console.log('[Auth] 환경변수 복구 성공!'); return true; }
      catch (e) { console.warn('[Auth] 환경변수 복구 실패:', e.message); }
    }

    // 4순위: 환경변수 CAFE24_ACCESS_TOKEN 직접
    if (process.env.CAFE24_ACCESS_TOKEN) {
      this.tokens = {
        access_token: process.env.CAFE24_ACCESS_TOKEN,
        refresh_token: envRefresh || '',
        expires_at: process.env.CAFE24_TOKEN_EXPIRES_AT || new Date(Date.now() + 7200000).toISOString(),
        refresh_token_expires_at: '', scopes: [],
      };
      this._saveTokens();
      return true;
    }

    console.log('[Auth] 토큰 없음 → /auth/login 최초 인증 필요');
    return false;
  }

  getAuthorizationUrl(scopes = []) {
    const s = (scopes.length ? scopes : ['mall.read_order','mall.read_product','mall.read_store','mall.read_supply','mall.read_analytics']).join(',');
    const state = Math.random().toString(36).substring(2, 15);
    return {
      url: `https://${this.baseUrl}/api/v2/oauth/authorize?response_type=code&client_id=${this.config.clientId}&state=${state}&redirect_uri=${encodeURIComponent(this.config.redirectUri)}&scope=${encodeURIComponent(s)}`,
      state,
    };
  }

  async getAccessToken(code) {
    const body = querystring.stringify({ grant_type:'authorization_code', code, redirect_uri:this.config.redirectUri });
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    console.log('[Auth] 신규 발급 완료 (만료: ' + this.tokens.expires_at + ')');
    return this.tokens;
  }

  async refreshAccessToken() {
    if (!this.tokens?.refresh_token) throw new Error('refresh_token 없음');
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      try {
        const body = querystring.stringify({ grant_type:'refresh_token', refresh_token:this.tokens.refresh_token });
        const data = await this._tokenRequest(body);
        this._setTokens(data);
        console.log('[Auth] 토큰 갱신 완료 (만료: ' + this.tokens.expires_at + ')');
        return this.tokens;
      } finally { this._refreshPromise = null; }
    })();

    return this._refreshPromise;
  }

  async _ensureValidToken() {
    if (!this.tokens?.access_token) {
      if (this.tokens?.refresh_token || process.env.CAFE24_REFRESH_TOKEN) {
        if (!this.tokens) this.tokens = {};
        if (!this.tokens.refresh_token) this.tokens.refresh_token = process.env.CAFE24_REFRESH_TOKEN;
        await this.refreshAccessToken();
        return;
      }
      // DB에서 복구 시도
      const dbToken = this._loadTokenFromDB();
      if (dbToken?.refresh_token) {
        this.tokens = this.tokens || {};
        this.tokens.refresh_token = dbToken.refresh_token;
        await this.refreshAccessToken();
        return;
      }
      throw new Error('인증 필요: /auth/login');
    }

    const exp = new Date(this.tokens.expires_at);
    if (Date.now() + 300_000 >= exp.getTime()) {
      try { await this.refreshAccessToken(); }
      catch (e) {
        // DB에서 최신 refresh_token 가져와 재시도
        const dbToken = this._loadTokenFromDB();
        if (dbToken?.refresh_token && dbToken.refresh_token !== this.tokens.refresh_token) {
          this.tokens.refresh_token = dbToken.refresh_token;
          await this.refreshAccessToken();
        } else { throw e; }
      }
    }
  }

  // ─── 토큰 저장 (파일 + DB) ───
  _setTokens(data) {
    this.tokens = {
      access_token: data.access_token,
      expires_at: data.expires_at,
      refresh_token: data.refresh_token,
      refresh_token_expires_at: data.refresh_token_expires_at,
      scopes: data.scopes,
      issued_at: data.issued_at,
    };
    this._saveTokens();
    this._saveTokenToDB(); // DB에도 영구 저장
  }

  _saveTokens() {
    try { fs.writeFileSync(path.resolve(this.config.tokenStorePath), JSON.stringify(this.tokens,null,2), 'utf8'); }
    catch(e) { /* Railway에서 파일 저장 실패는 정상 */ }
  }

  /** DB에 최신 토큰 저장 — 배포/재시작 후에도 유지 */
  _saveTokenToDB() {
    if (!this._orderDB?.db) return;
    try {
      // token_store 테이블이 없으면 생성
      this._orderDB.db.run(`CREATE TABLE IF NOT EXISTS token_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )`);
      this._orderDB.db.run(
        `INSERT OR REPLACE INTO token_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
        ['cafe24_tokens', JSON.stringify(this.tokens)]
      );
      this._orderDB._persist();
      console.log('[Auth] 토큰 DB 저장 완료');
    } catch (e) {
      console.warn('[Auth] 토큰 DB 저장 실패:', e.message);
    }
  }

  /** DB에서 최신 토큰 로드 */
  _loadTokenFromDB() {
    if (!this._orderDB?.db) return null;
    try {
      const result = this._orderDB.db.exec("SELECT value FROM token_store WHERE key = 'cafe24_tokens'");
      if (result?.[0]?.values?.[0]?.[0]) {
        const tokens = JSON.parse(result[0].values[0][0]);
        console.log('[Auth] DB에서 토큰 로드 (refresh: ' + (tokens.refresh_token?.substring(0,15) || '?') + '...)');
        return tokens;
      }
    } catch (e) { /* 테이블 미존재 시 무시 */ }
    return null;
  }

  _loadTokens() {
    // 1순위: 파일
    try {
      const f = path.resolve(this.config.tokenStorePath);
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (data?.access_token) { console.log('[Auth] tokens.json 로드'); return data; }
      }
    } catch(e) {}

    // 2순위: 환경변수
    if (process.env.CAFE24_ACCESS_TOKEN || process.env.CAFE24_REFRESH_TOKEN) {
      console.log('[Auth] 환경변수 토큰 로드');
      return {
        access_token: process.env.CAFE24_ACCESS_TOKEN || '',
        refresh_token: process.env.CAFE24_REFRESH_TOKEN || '',
        expires_at: process.env.CAFE24_TOKEN_EXPIRES_AT || '',
        refresh_token_expires_at: '', scopes: [],
      };
    }
    return null;
  }

  // ─── API 메서드 ───
  async getOrders(params = {}) { return this._get('/api/v2/admin/orders', { limit:50, offset:0, embed:'items', ...params }); }
  async getOrder(id) { return this._get(`/api/v2/admin/orders/${id}`, { embed:'items,receivers,buyer' }); }
  async getOrdersCount(params = {}) { return this._get('/api/v2/admin/orders/count', params); }

  async getAllOrders(startDate, endDate, extraParams = {}) {
    await this._ensureValidToken();
    // 날짜 목록 생성 (일별 분할 — offset 10,000 제한 우회)
    const dates = [];
    const d = new Date(startDate);
    const end = new Date(endDate);
    while (d <= end) { dates.push(d.toISOString().substring(0,10)); d.setDate(d.getDate()+1); }
    
    let allOrders = [];
    for (const date of dates) {
      // 일별 건수 확인
      const countRes = await this._get('/api/v2/admin/orders/count', { start_date:date, end_date:date, ...extraParams }).catch(()=>({count:0}));
      const dayTotal = countRes?.count ?? 0;
      if (dayTotal === 0) continue;
      
      // offset 생성 (최대 10,000까지)
      const maxOffset = Math.min(dayTotal, 10000);
      const offsets = [];
      for (let offset = 0; offset < maxOffset; offset += PAGE_SIZE) offsets.push(offset);
      
      console.log(`[Cafe24] ${date}: ${dayTotal}건 → ${offsets.length}p`);
      
      const pages = await this._parallelPages(offsets, (offset) =>
        this._get('/api/v2/admin/orders', { start_date:date, end_date:date, embed:'items', ...extraParams, limit:PAGE_SIZE, offset })
          .then(r => r?.orders ?? r?.data?.orders ?? []).catch(() => [])
      );
      allOrders = allOrders.concat(pages.flat());
    }
    console.log(`[Cafe24] 전체 ${startDate}~${endDate}: ${allOrders.length}건 수집`);
    return allOrders;
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
      this._get('/api/v2/admin/products', { limit:100, offset, embed:'variants,inventories' }).then(r => r?.products ?? []).catch(() => [])
    );
    return pages.flat();
  }

  async getInventory(pn, vc = null) {
    if (vc) return this._get(`/api/v2/admin/products/${pn}/variants/${vc}/inventories`);
    return this._get(`/api/v2/admin/products/${pn}/variants`, { embed:'inventories' });
  }
  async updateInventory(pn, vc, data) { return this._put(`/api/v2/admin/products/${pn}/variants/${vc}/inventories`, { request:data }); }

  async getFullInventoryReport() {
    const products = await this.getAllProducts();
    return products.flatMap(p => (p.variants||[]).map(v => {
      const inv = v.inventories || {};
      return { product_no:p.product_no, product_name:p.product_name, variant_code:v.variant_code, option_value:v.option_value||'-', quantity:inv.quantity??0, safety_inventory:inv.safety_inventory??0, use_inventory:inv.use_inventory??'F', selling:p.selling==='T', display:p.display==='T' };
    }));
  }

  async getDashboard() { return this._get('/api/v2/admin/dashboard'); }

  async getSalesAnalytics(startDate, endDate) {
    const orders = await this.getAllOrders(startDate, endDate);
    let totalRevenue = 0;
    const dailySales = {}, productSales = {};
    for (const o of orders) {
      const st = o.order_status || '';
      if (st.startsWith('C') || st.startsWith('R')) continue;
      const amt = parseFloat(o.payment_amount || o.actual_payment_amount || o.total_price || 0);
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
    const valid = orders.filter(o => { const s=o.order_status||''; return !s.startsWith('C')&&!s.startsWith('R'); });
    return { period:{startDate,endDate}, totalRevenue, orderCount:valid.length, avgOrderValue:valid.length>0?Math.round(totalRevenue/valid.length):0, dailySales:Object.entries(dailySales).map(([date,amount])=>({date,amount})).sort((a,b)=>a.date.localeCompare(b.date)), topProducts:Object.values(productSales).sort((a,b)=>b.revenue-a.revenue).slice(0,20) };
  }

  async _parallelPages(offsets, fetchFn) {
    const results = [];
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      const pages = await Promise.all(offsets.slice(i, i + CONCURRENCY).map(fetchFn));
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
    if (this._bucket.remaining <= 2) await this._sleep(Math.max(MIN_DELAY_MS, 1000/this._bucket.limit*CONCURRENCY*1.2));
    else await this._sleep(MIN_DELAY_MS);
    try { return await this._rawRequest(opts); }
    catch (e) {
      if (e.statusCode === 401 && retries > 0 && this.tokens?.refresh_token) {
        try { await this.refreshAccessToken(); return this._apiRequest(opts, retries - 1); }
        catch (re) { throw e; }
      }
      if (e.statusCode === 429 && retries > 0) { await this._sleep(RATE_LIMIT_DELAY); return this._apiRequest(opts, retries - 1); }
      throw e;
    }
  }

  _rawRequest(opts) {
    return new Promise((resolve, reject) => {
      const reqOpts = { hostname: this.baseUrl, path: opts.path, method: opts.method||'GET', headers: { 'Authorization': `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': this.config.apiVersion } };
      if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
      const req = https.request(reqOpts, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => {
          const lh = res.headers['x-api-call-limit'];
          if (lh) { const [used,total] = lh.split('/').map(Number); this._bucket = { remaining:total-used, limit:total }; }
          try {
            const parsed = JSON.parse(d);
            if (res.statusCode === 429) { const e = new Error('Too Many Requests'); e.statusCode=429; return reject(e); }
            if (res.statusCode >= 400) { const e = new Error(parsed?.error?.message||`API ${res.statusCode}`); e.statusCode=res.statusCode; return reject(e); }
            resolve(parsed);
          } catch (e) { reject(new Error('Parse: '+d.substring(0,200))); }
        });
      });
      req.on('error', reject); if (opts.body) req.write(opts.body); req.end();
    });
  }

  async _tokenRequest(body) {
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: this.baseUrl, path:'/api/v2/oauth/token', method:'POST', headers: { 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => {
          try { const p = JSON.parse(d); res.statusCode>=400 ? reject(new Error(`Auth ${res.statusCode}: ${JSON.stringify(p)}`)) : resolve(p); }
          catch (e) { reject(new Error('Auth parse fail')); }
        });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Cafe24Client;
