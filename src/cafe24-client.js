const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

class Cafe24Client {
  constructor(config = {}) {
    this.config = { mallId:'', clientId:'', clientSecret:'', redirectUri:'', apiVersion:'2026-03-01', tokenStorePath:'./tokens.json', ...config };
    this.baseUrl = `${this.config.mallId}.cafe24api.com`;
    this.tokens = this._loadTokens();
    this._bucket = { remaining:10, limit:10 };
    this._requestQueue = [];
    this._processing = false;
  }

  getAuthorizationUrl(scopes=[]) {
    const s = (scopes.length?scopes:['mall.read_order','mall.read_product','mall.read_store','mall.read_supply']).join(',');
    const state = Math.random().toString(36).substring(2,15);
    return { url:`https://${this.baseUrl}/api/v2/oauth/authorize?response_type=code&client_id=${this.config.clientId}&state=${state}&redirect_uri=${encodeURIComponent(this.config.redirectUri)}&scope=${encodeURIComponent(s)}`, state };
  }

  async getAccessToken(code) {
    const body = querystring.stringify({ grant_type:'authorization_code', code, redirect_uri:this.config.redirectUri });
    const data = await this._tokenRequest(body);
    this.tokens = { access_token:data.access_token, expires_at:data.expires_at, refresh_token:data.refresh_token, refresh_token_expires_at:data.refresh_token_expires_at, scopes:data.scopes, issued_at:data.issued_at };
    this._saveTokens();
    return this.tokens;
  }

  async refreshAccessToken() {
    if (!this.tokens?.refresh_token) throw new Error('refresh_token 없음');
    const body = querystring.stringify({ grant_type:'refresh_token', refresh_token:this.tokens.refresh_token });
    const data = await this._tokenRequest(body);
    this.tokens = { access_token:data.access_token, expires_at:data.expires_at, refresh_token:data.refresh_token, refresh_token_expires_at:data.refresh_token_expires_at, scopes:data.scopes, issued_at:data.issued_at };
    this._saveTokens();
    return this.tokens;
  }

  async _ensureValidToken() {
    if (!this.tokens?.access_token) throw new Error('인증 필요');
    const now = new Date(), exp = new Date(this.tokens.expires_at);
    if (now.getTime()+300000 >= exp.getTime()) await this.refreshAccessToken();
  }

  async getOrders(params={}) { return this._get('/api/v2/admin/orders', { limit:50, offset:0, embed:'items', ...params }); }
  async getOrder(id) { return this._get(`/api/v2/admin/orders/${id}`, { embed:'items,receivers,buyer' }); }
  async getOrdersCount(params={}) { return this._get('/api/v2/admin/orders/count', params); }

  async getAllOrders(startDate, endDate) {
    const all=[]; let offset=0, hasMore=true;
    while(hasMore) {
      try {
        const r=await this.getOrders({ start_date:startDate, end_date:endDate, limit:100, offset, embed:'items' });
        const o=(r&&r.orders)?r.orders:((r&&r.data&&r.data.orders)?r.data.orders:[]);
        if(!o||!o.length){hasMore=false;break;}
        all.push(...o); offset+=100; hasMore=o.length===100;
        console.log('[Cafe24] orders fetched: '+all.length);
      } catch(e) { console.error('[Cafe24] getAllOrders error at offset '+offset+': '+e.message); hasMore=false; }
    }
    return all;
  }

  async getProducts(params={}) { return this._get('/api/v2/admin/products', { limit:100, offset:0, ...params }); }
  async getProduct(no) { return this._get(`/api/v2/admin/products/${no}`, { embed:'variants,inventories' }); }
  async getProductsCount(params={}) { return this._get('/api/v2/admin/products/count', params); }

  async getAllProducts() {
    const all=[]; let offset=0, hasMore=true;
    while(hasMore) { const r=await this.getProducts({ limit:100, offset, embed:'variants,inventories' }); const p=r.products||[]; all.push(...p); offset+=100; hasMore=p.length===100; }
    return all;
  }

  async getInventory(productNo, variantCode=null) {
    if (variantCode) return this._get(`/api/v2/admin/products/${productNo}/variants/${variantCode}/inventories`);
    return this._get(`/api/v2/admin/products/${productNo}/variants`, { embed:'inventories' });
  }

  async updateInventory(productNo, variantCode, data) { return this._put(`/api/v2/admin/products/${productNo}/variants/${variantCode}/inventories`, { request:data }); }

  async getFullInventoryReport() {
    const products = await this.getAllProducts();
    const report = [];
    for (const p of products) { for (const v of (p.variants||[])) { const inv=v.inventories||{}; report.push({ product_no:p.product_no, product_name:p.product_name, variant_code:v.variant_code, option_value:v.option_value||'-', quantity:inv.quantity??0, safety_inventory:inv.safety_inventory??0, use_inventory:inv.use_inventory??'F', selling:p.selling==='T', display:p.display==='T' }); } }
    return report;
  }

  async getDashboard() { return this._get('/api/v2/admin/dashboard'); }

  async getSalesAnalytics(startDate, endDate) {
    const orders = await this.getAllOrders(startDate, endDate);
    let totalRevenue=0; const dailySales={}, productSales={};
    for (const o of orders) { const st=o.order_status||''; if(st.startsWith('C')||st.startsWith('R')) continue; const amt=parseFloat(o.actual_payment_amount||o.total_amount_paid||0); totalRevenue+=amt; const d=(o.order_date||'').substring(0,10); if(d) dailySales[d]=(dailySales[d]||0)+amt; for(const item of (o.items||[])) { const k=item.product_no||item.product_name; if(!productSales[k]) productSales[k]={product_no:item.product_no,product_name:item.product_name,quantity:0,revenue:0}; productSales[k].quantity+=parseInt(item.quantity||0); productSales[k].revenue+=parseFloat(item.product_price||0)*parseInt(item.quantity||0); } }
    const valid=orders.filter(o=>{const s=o.order_status||'';return !s.startsWith('C')&&!s.startsWith('R')});
    return { period:{startDate,endDate}, totalRevenue, orderCount:valid.length, avgOrderValue:valid.length>0?Math.round(totalRevenue/valid.length):0, dailySales:Object.entries(dailySales).map(([date,amount])=>({date,amount})).sort((a,b)=>a.date.localeCompare(b.date)), topProducts:Object.values(productSales).sort((a,b)=>b.revenue-a.revenue).slice(0,20) };
  }

  async _get(ep, params={}) { await this._ensureValidToken(); const qs=Object.keys(params).length?'?'+querystring.stringify(params):''; return this._rateLimitedRequest({ method:'GET', path:ep+qs }); }
  async _put(ep, body) { await this._ensureValidToken(); return this._rateLimitedRequest({ method:'PUT', path:ep, body:JSON.stringify(body) }); }

  async _tokenRequest(body) {
    const auth=Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    return new Promise((resolve,reject)=>{
      const req=https.request({ hostname:this.baseUrl, path:'/api/v2/oauth/token', method:'POST', headers:{ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } },(res)=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); res.statusCode>=400?reject(new Error(`Auth ${res.statusCode}: ${JSON.stringify(p)}`)):resolve(p); }catch(e){reject(new Error('Auth parse fail'));} }); });
      req.on('error',reject); req.write(body); req.end();
    });
  }

  async _rateLimitedRequest(opts, retries=3) {
    return new Promise((resolve,reject)=>{ this._requestQueue.push({opts,retries,resolve,reject}); this._processQueue(); });
  }

  async _processQueue() {
    if(this._processing||!this._requestQueue.length) return;
    this._processing=true;
    while(this._requestQueue.length) {
      const{opts,retries,resolve,reject}=this._requestQueue.shift();
      try{ if(this._bucket.remaining<=1) await this._sleep(500); const r=await this._rawRequest(opts); resolve(r); }
      catch(e){ if(e.statusCode===429&&retries>0){ await this._sleep(1000); this._requestQueue.unshift({opts,retries:retries-1,resolve,reject}); } else reject(e); }
      await this._sleep(520);
    }
    this._processing=false;
  }

  _rawRequest(opts) {
    return new Promise((resolve,reject)=>{
      const o={ hostname:this.baseUrl, path:opts.path, method:opts.method||'GET', headers:{ 'Authorization':`Bearer ${this.tokens.access_token}`, 'Content-Type':'application/json', 'X-Cafe24-Api-Version':this.config.apiVersion } };
      if(opts.body) o.headers['Content-Length']=Buffer.byteLength(opts.body);
      const req=https.request(o,(res)=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ const lh=res.headers['x-api-call-limit']; if(lh){const[u,t]=lh.split('/').map(Number);this._bucket.remaining=t-u;} try{ const p=JSON.parse(d); if(res.statusCode===429){const e=new Error('Too Many Requests');e.statusCode=429;reject(e);return;} if(res.statusCode>=400){const e=new Error(`API ${res.statusCode}`);e.statusCode=res.statusCode;reject(e);return;} resolve(p); }catch(e){reject(new Error('Parse fail'));} }); });
      req.on('error',reject); if(opts.body) req.write(opts.body); req.end();
    });
  }

  _loadTokens() { try{ const f=path.resolve(this.config.tokenStorePath); if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){} return null; }
  _saveTokens() { try{ fs.writeFileSync(path.resolve(this.config.tokenStorePath),JSON.stringify(this.tokens,null,2),'utf8'); }catch(e){} }
  _sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
}

module.exports = Cafe24Client;
