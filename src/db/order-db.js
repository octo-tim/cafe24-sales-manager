/**
 * ============================================================
 *  주문 데이터베이스 (sql.js — 순수 JS SQLite)
 *  + 재고관리 (inventory) 테이블
 * ============================================================
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || (process.env.RAILWAY_ENVIRONMENT ? '/app/persistent/orders.db' : path.join(__dirname, '..', '..', 'data', 'orders.db'));

class OrderDB {
  constructor() {
    this.db = null;
    this._ready = this._init();
  }

  async _init() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      try {
        const stat = fs.statSync(DB_PATH);
        console.log(`[DB] 기존 DB 파일 발견: ${DB_PATH} (${Math.round(stat.size/1024/1024)}MB)`);
        const buf = fs.readFileSync(DB_PATH);
        this.db = new SQL.Database(buf);
        console.log(`[DB] 기존 DB 로드 완료: ${DB_PATH}`);
      } catch(e) {
        console.error(`[DB] 기존 DB 로드 실패: ${e.message} — 새 DB 생성`);
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
      console.log(`[DB] 새 DB 생성: ${DB_PATH}`);
    }
    this._migrate();
    this._saveInterval = setInterval(() => this._persist(), 30000);
  }

  async ensureReady() { await this._ready; }

  _migrate() {
    // 주문
    this.db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, channel TEXT NOT NULL, order_id TEXT NOT NULL, order_date TEXT NOT NULL, status TEXT DEFAULT '', product_name TEXT DEFAULT '', product_no TEXT DEFAULT '', variant_code TEXT DEFAULT '', quantity INTEGER DEFAULT 1, amount REAL DEFAULT 0, customer TEXT DEFAULT '', raw_json TEXT DEFAULT '{}', collected_at TEXT DEFAULT (datetime('now')), UNIQUE(channel, id))`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_ch_date ON orders(channel, order_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_variant ON orders(variant_code)`);

    // 마이그레이션: 기존 DB에 variant_code/supplier_option 컬럼 추가
    try { this.db.run('ALTER TABLE orders ADD COLUMN variant_code TEXT DEFAULT ""'); } catch(e) {}
    try { this.db.run('ALTER TABLE inventory ADD COLUMN supplier_option TEXT DEFAULT ""'); } catch(e) {}
    try { this.db.run('ALTER TABLE inventory ADD COLUMN base_date TEXT DEFAULT ""'); } catch(e) {}
    // 수집 이력
    this.db.run(`CREATE TABLE IF NOT EXISTS collect_history (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_type TEXT NOT NULL, timestamp TEXT NOT NULL, duration INTEGER DEFAULT 0, period_start TEXT, period_end TEXT, period_days INTEGER DEFAULT 0, total_count INTEGER DEFAULT 0, channels_json TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')))`);
    // 일별 요약
    this.db.run(`CREATE TABLE IF NOT EXISTS daily_summary (date TEXT NOT NULL, channel TEXT NOT NULL, order_count INTEGER DEFAULT 0, total_amount REAL DEFAULT 0, avg_order REAL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(date, channel))`);
    // ★ 재고 마스터 (엑셀 업로드)
    this.db.run(`CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_code TEXT NOT NULL, barcode TEXT DEFAULT '', product_name TEXT NOT NULL, option_name TEXT DEFAULT '', category TEXT DEFAULT '', supplier TEXT DEFAULT '', supplier_option TEXT DEFAULT '', cost_price REAL DEFAULT 0, sell_price REAL DEFAULT 0, stock_qty INTEGER DEFAULT 0, defect_qty INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')), UNIQUE(product_name, option_name))`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_inv_code ON inventory(product_code)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_inv_name ON inventory(product_name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_inv_supplier_opt ON inventory(supplier_option)`);
    // ★ 기초재고 스냅샷 (날짜별)
    this.db.run(`CREATE TABLE IF NOT EXISTS inventory_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, product_code TEXT NOT NULL, product_name TEXT NOT NULL, option_name TEXT DEFAULT '', base_stock INTEGER DEFAULT 0, shipped INTEGER DEFAULT 0, expected_stock INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(date, product_code, option_name))`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_snap_date ON inventory_snapshot(date)`);
    // 마이그레이션: supplier, category 컬럼 추가
    try { this.db.run('ALTER TABLE inventory_snapshot ADD COLUMN supplier TEXT DEFAULT ""'); } catch(e) {}
    try { this.db.run('ALTER TABLE inventory_snapshot ADD COLUMN category TEXT DEFAULT ""'); } catch(e) {}
    // raw_json 정리 (DB 크기 최적화 — 1.1GB → ~50MB)
    try {
      const rawSize = this.db.exec("SELECT SUM(LENGTH(raw_json)) FROM orders WHERE raw_json != '' AND raw_json != '{}'")[0]?.values?.[0]?.[0] || 0;
      if (rawSize > 1000000) { // 1MB 이상이면 정리
        console.log('[DB] raw_json 정리 시작 (' + Math.round(rawSize/1024/1024) + 'MB)...');
        this.db.run("UPDATE orders SET raw_json = '' WHERE raw_json != '' AND raw_json != '{}'");
        console.log('[DB] raw_json 정리 완료 → VACUUM 실행...');
        try { this.db.run('VACUUM'); } catch(ve) { console.warn('[DB] VACUUM 실패:', ve.message); }
        this._persist();
        const newSize = fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size/1024/1024) : 0;
        console.log('[DB] VACUUM 후 DB 크기: ' + newSize + 'MB');
      }
    } catch(e) { console.warn('[DB] raw_json 정리 실패:', e.message); }
    // 토큰 저장
    this.db.run(`CREATE TABLE IF NOT EXISTS token_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  }

  _persist() {
    try {
      const d = this.db.export();
      const buf = Buffer.from(d);
      const tmpPath = DB_PATH + '.tmp';
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, DB_PATH);
    } catch (e) { console.warn('[DB] 저장 실패:', e.message); }
  }

  /** 서버 종료 시 안전 저장 */
  shutdown() {
    console.log('[DB] Shutdown — 최종 저장...');
    if (this._saveInterval) clearInterval(this._saveInterval);
    this._persist();
    console.log('[DB] Shutdown 완료');
  }

  // ═══════════════════════════════════════════════
  //  재고 관리
  // ═══════════════════════════════════════════════

  /** 엑셀 파싱된 재고 데이터 저장 (전체 교체) */
  saveInventory(items, baseDate = '') {
    if (!items?.length) return { inserted: 0 };
    this.db.run('DELETE FROM inventory');
    const stmt = this.db.prepare('INSERT OR REPLACE INTO inventory (product_code, barcode, product_name, option_name, category, supplier, supplier_option, cost_price, sell_price, stock_qty, defect_qty, base_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    let cnt = 0;
    for (const it of items) {
      try {
        stmt.run([it.product_code, it.barcode||'', it.product_name, it.option_name||'', it.category||'', it.supplier||'', it.supplier_option||'', it.cost_price||0, it.sell_price||0, it.stock_qty||0, it.defect_qty||0, baseDate]);
        cnt++;
      } catch(e) {}
    }
    stmt.free();
    this._persist();
    console.log(`[DB] 재고 ${cnt}건 저장`);
    return { inserted: cnt };
  }

  /** 전체 재고 목록 */
  getInventory(opts = {}) {
    let sql = 'SELECT product_code, barcode, product_name, option_name, category, supplier, supplier_option, cost_price, sell_price, stock_qty, defect_qty FROM inventory';
    const conds = [];
    if (opts.category) conds.push(`category = '${opts.category}'`);
    if (opts.search) conds.push(`(product_name LIKE '%${opts.search}%' OR product_code LIKE '%${opts.search}%' OR barcode LIKE '%${opts.search}%')`);
    if (opts.stockOnly) conds.push('stock_qty > 0');
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY stock_qty DESC';
    if (opts.limit) sql += ` LIMIT ${opts.limit}`;
    return this.db.exec(sql)[0]?.values?.map(r => ({product_code:r[0],barcode:r[1],product_name:r[2],option_name:r[3],category:r[4],supplier:r[5],supplier_option:r[6],cost_price:r[7],sell_price:r[8],stock_qty:r[9],defect_qty:r[10]})) || [];
  }

  /** 재고 통계 */
  getInventoryStats() {
    const total = this.db.exec('SELECT COUNT(*), SUM(stock_qty), COUNT(CASE WHEN stock_qty > 0 THEN 1 END), COUNT(CASE WHEN stock_qty = 0 THEN 1 END) FROM inventory')[0]?.values?.[0] || [0,0,0,0];
    const byCat = this.db.exec('SELECT category, COUNT(*), SUM(stock_qty) FROM inventory GROUP BY category ORDER BY SUM(stock_qty) DESC')[0]?.values?.map(r => ({category:r[0],count:r[1],stock:r[2]})) || [];
    return { totalProducts: total[0], totalStock: total[1], inStock: total[2], outOfStock: total[3], byCategory: byCat };
  }

  /** 날짜별 기초재고 스냅샷 생성 (재고 - 당일출고 = 예상재고) */
  createDailySnapshot(date) {
    // 기존 스냅샷 삭제
    this.db.run(`DELETE FROM inventory_snapshot WHERE date = ?`, [date]);

    // 재고 마스터에서 기초재고 가져오기
    const inventory = this.getInventory();
    if (!inventory.length) return { created: 0, message: '재고 데이터 없음' };

    // 당일 주문에서 출고 수량 집계 (상품명 기준 매칭)
    const orderQtyByVariant = {};
    const rows = this.db.exec(`SELECT variant_code, SUM(quantity) FROM orders WHERE order_date = '${date}' AND variant_code != '' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' GROUP BY variant_code`)[0]?.values || [];
    for (const [vc, qty] of rows) { orderQtyByVariant[vc] = qty; }

    // 상품코드 기준으로도 매칭 시도
    const orderQtyByName = {};
    const rows2 = this.db.exec(`SELECT product_name, SUM(quantity) FROM orders WHERE order_date = '${date}' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' GROUP BY product_name`)[0]?.values || [];
    for (const [name, qty] of rows2) { orderQtyByName[name] = qty; }

    const stmt = this.db.prepare('INSERT OR REPLACE INTO inventory_snapshot (date, product_code, product_name, option_name, base_stock, shipped, expected_stock, supplier, category) VALUES (?,?,?,?,?,?,?,?,?)');
    let created = 0;

    for (const item of inventory) {
      const baseStock = item.stock_qty || 0;
      // 출고량: supplier_option → variant_code (1순위) → 상품명 (2순위) → 0
      const shipped = (item.supplier_option && orderQtyByVariant[item.supplier_option]) || orderQtyByName[item.product_name] || 0;
      const expected = baseStock - shipped;

      stmt.run([date, item.product_code, item.product_name, item.option_name, baseStock, shipped, expected, item.supplier||'', item.category||'']);
      created++;
    }
    stmt.free();
    this._persist();
    return { created, date, totalShipped: Object.values(orderQtyByVariant).reduce((s,v)=>s+v, 0) + Object.values(orderQtyByName).reduce((s,v)=>s+v, 0) };
  }

  /** 날짜별 스냅샷 조회 */
  getSnapshot(date, opts = {}) {
    let sql = `SELECT product_code, product_name, option_name, base_stock, shipped, expected_stock, supplier, category FROM inventory_snapshot WHERE date = '${date}'`;
    if (opts.search) sql += ` AND (product_name LIKE '%${opts.search}%' OR product_code LIKE '%${opts.search}%')`;
    if (opts.shippedOnly) sql += ' AND shipped > 0';
    if (opts.supplier) sql += ` AND supplier = '${opts.supplier}'`;
    if (opts.category) sql += ` AND category = '${opts.category}'`;
    sql += ' ORDER BY shipped DESC, base_stock DESC';
    if (opts.limit) sql += ` LIMIT ${opts.limit}`;
    return this.db.exec(sql)[0]?.values?.map(r => ({product_code:r[0],product_name:r[1],option_name:r[2],base_stock:r[3],shipped:r[4],expected_stock:r[5],supplier:r[6]||'',category:r[7]||''})) || [];
  }

  /** 스냅샷 요약 */
  getSnapshotSummary(date, opts = {}) {
    let where = `date = '${date}'`;
    if (opts.supplier) where += ` AND supplier = '${opts.supplier}'`;
    if (opts.category) where += ` AND category = '${opts.category}'`;
    const r = this.db.exec(`SELECT COUNT(*), SUM(base_stock), SUM(shipped), SUM(expected_stock), COUNT(CASE WHEN shipped > 0 THEN 1 END) FROM inventory_snapshot WHERE ${where}`)[0]?.values?.[0] || [0,0,0,0,0];
    return { date, totalProducts: r[0], totalBaseStock: r[1], totalShipped: r[2], totalExpected: r[3], movedProducts: r[4] };
  }

  /** 스냅샷이 있는 날짜 목록 */
  getSnapshotFilters(date) {
    const suppliers = this.db.exec(`SELECT DISTINCT supplier FROM inventory_snapshot WHERE date = '${date}' AND supplier != '' ORDER BY supplier`)[0]?.values?.map(r=>r[0]) || [];
    const categories = this.db.exec(`SELECT DISTINCT category FROM inventory_snapshot WHERE date = '${date}' AND category != '' ORDER BY category`)[0]?.values?.map(r=>r[0]) || [];
    return { suppliers, categories };
  }
  getStockStatus(startDate, endDate, opts = {}) {
    // 재고 마스터 + base_date(기준일) 조회
    let invSql = 'SELECT product_code, barcode, product_name, option_name, category, supplier, supplier_option, cost_price, sell_price, stock_qty, defect_qty, base_date FROM inventory WHERE 1=1';
    if (opts.search) invSql += ` AND (product_name LIKE '%${opts.search}%' OR product_code LIKE '%${opts.search}%')`;
    if (opts.supplier) invSql += ` AND supplier = '${opts.supplier}'`;
    if (opts.category) invSql += ` AND category = '${opts.category}'`;
    invSql += ' ORDER BY stock_qty DESC';
    const inventory = this.db.exec(invSql)[0]?.values?.map(r => ({
      product_code:r[0], barcode:r[1], product_name:r[2], option_name:r[3],
      category:r[4], supplier:r[5], supplier_option:r[6],
      cost_price:r[7], sell_price:r[8], stock_qty:r[9]||0, defect_qty:r[10]||0,
      base_date:r[11]||''
    })) || [];
    if (!inventory.length) return { summary: { startDate, endDate, baseDate:'', totalProducts:0, totalBaseStock:0, totalShipped:0, totalExpected:0, movedProducts:0 }, items: [] };

    const baseDate = inventory[0].base_date || startDate;

    // 출고 제외 조건: 반품(R%), 취소(C%), CANCELED, RETURNED 제외
    const excludeStatus = "AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' AND status != 'RETURNED' AND status != 'refund'";

    // 기준일 ~ 조회시작일 전일까지 누적 출고 → 기초재고 계산
    const prevShippedByVariant = {};
    const r1 = this.db.exec(`SELECT variant_code, SUM(quantity) FROM orders WHERE order_date >= '${baseDate}' AND order_date < '${startDate}' AND variant_code != '' ${excludeStatus} GROUP BY variant_code`)[0]?.values || [];
    for (const [vc, qty] of r1) { prevShippedByVariant[vc] = qty; }
    const prevShippedByName = {};
    const r2 = this.db.exec(`SELECT product_name, SUM(quantity) FROM orders WHERE order_date >= '${baseDate}' AND order_date < '${startDate}' ${excludeStatus} GROUP BY product_name`)[0]?.values || [];
    for (const [name, qty] of r2) { prevShippedByName[name] = qty; }

    // 조회기간 출고 (startDate ~ endDate)
    const periodShippedByVariant = {};
    const r3 = this.db.exec(`SELECT variant_code, SUM(quantity) FROM orders WHERE order_date >= '${startDate}' AND order_date <= '${endDate}' AND variant_code != '' ${excludeStatus} GROUP BY variant_code`)[0]?.values || [];
    for (const [vc, qty] of r3) { periodShippedByVariant[vc] = qty; }
    const periodShippedByName = {};
    const r4 = this.db.exec(`SELECT product_name, SUM(quantity) FROM orders WHERE order_date >= '${startDate}' AND order_date <= '${endDate}' ${excludeStatus} GROUP BY product_name`)[0]?.values || [];
    for (const [name, qty] of r4) { periodShippedByName[name] = qty; }

    let items = [], totalBase = 0, totalShipped = 0, totalExpected = 0, movedCount = 0;
    for (const item of inventory) {
      const uploadQty = item.stock_qty;

      // 기초재고 = 업로드수량 - (기준일 ~ 조회시작일 전일 누적출고)
      const prevShipped = (item.supplier_option && prevShippedByVariant[item.supplier_option]) || prevShippedByName[item.product_name] || 0;
      const baseStock = uploadQty - prevShipped;

      // 기간 출고 (반품/취소/환불 제외)
      const periodShipped = (item.supplier_option && periodShippedByVariant[item.supplier_option]) || periodShippedByName[item.product_name] || 0;

      // 예상기말재고 = 기초재고 - 기간출고
      const expected = baseStock - periodShipped;

      totalBase += baseStock; totalShipped += periodShipped; totalExpected += expected;
      if (periodShipped > 0) movedCount++;
      if (opts.shippedOnly && periodShipped <= 0) continue;
      items.push({ product_code:item.product_code, product_name:item.product_name, option_name:item.option_name, supplier:item.supplier, category:item.category, base_stock:baseStock, shipped:periodShipped, expected_stock:expected });
    }
    items.sort((a, b) => b.shipped - a.shipped || b.base_stock - a.base_stock);
    if (opts.limit) items = items.slice(0, opts.limit);
    return { summary: { startDate, endDate, baseDate, totalProducts:inventory.length, totalBaseStock:totalBase, totalShipped:totalShipped, totalExpected:totalExpected, movedProducts:movedCount }, items };
  }
  getSnapshotDates() {
    return this.db.exec('SELECT DISTINCT date FROM inventory_snapshot ORDER BY date DESC LIMIT 30')[0]?.values?.map(r => r[0]) || [];
  }

  // ═══════════════════════════════════════════════
  //  주문 저장 (기존 유지)
  // ═══════════════════════════════════════════════

  saveOrders(channel, orders) {
    if (!orders || !orders.length) return { inserted: 0, total: 0 };
    let inserted = 0;
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO orders (id, channel, order_id, order_date, status, product_name, product_no, variant_code, quantity, amount, customer, raw_json, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    for (const order of orders) {
      try {
        const rows = this._normalizeOrder(channel, order);
        for (const n of rows) {
          stmt.run([n.id, n.channel, n.order_id, n.order_date, n.status, n.product_name, n.product_no, n.variant_code, n.quantity, n.amount, n.customer, n.raw_json]);
          inserted++;
        }
      } catch (e) {}
    }
    stmt.free();
    this._refreshDailySummary(channel);
    this._persist();
    return { inserted, total: orders.length };
  }

  _normalizeOrder(channel, raw) {
    switch (channel) {
      case '카페24': {
        const orderId = String(raw.order_id||raw.order_no||Date.now());
        const orderDate = (raw.order_date||raw.created_date||'').substring(0,10);
        const status = raw.order_status||'';
        const customer = raw.buyer_name||'';
        const items = raw.items || [];
        if (items.length <= 1) {
          return [{ id:`c24_${orderId}`, channel, order_id:orderId, order_date:orderDate, status, product_name:items[0]?.product_name||'', product_no:String(items[0]?.product_no||''), variant_code:String(items[0]?.custom_variant_code||items[0]?.variant_code||''), quantity:items.reduce((s,i)=>s+parseInt(i.quantity||1),0)||1, amount:parseFloat(raw.payment_amount||raw.actual_payment_amount||raw.total_price||0), customer, raw_json:'' }];
        }
        // 여러 items → item별 분리 저장
        return items.map((item, idx) => ({
          id:`c24_${orderId}_${idx}`,
          channel, order_id:orderId, order_date:orderDate, status,
          product_name:item.product_name||'',
          product_no:String(item.product_no||''),
          variant_code:String(item.custom_variant_code||item.variant_code||''),
          quantity:parseInt(item.quantity||1),
          amount:parseFloat(item.payment_amount||item.product_price||0)*parseInt(item.quantity||1),
          customer, raw_json:''
        }));
      }
      case '쿠팡': return [{ id:`cpg_${raw.orderId||raw.shipmentBoxId||Date.now()}`, channel, order_id:String(raw.orderId||raw.shipmentBoxId||''), order_date:(raw.orderedAt||raw.createdAt||'').substring(0,10), status:raw.status||'', product_name:raw.vendorItemName||'', product_no:String(raw.vendorItemId||''), variant_code:'', quantity:parseInt(raw.shippingCount||1), amount:parseFloat(raw.orderPrice||raw.totalPrice||0), customer:raw.receiver?.name||'', raw_json:'' }];
      case '네이버': return [{ id:`nvr_${raw.productOrderId||raw.orderId||Date.now()}`, channel, order_id:String(raw.productOrderId||raw.orderId||''), order_date:(raw.orderDate||raw.paymentDate||'').substring(0,10), status:raw._searchStatus||raw.productOrderStatus||'', product_name:raw.productName||'', product_no:String(raw.productId||''), variant_code:'', quantity:parseInt(raw.quantity||1), amount:parseFloat(raw.totalPaymentAmount||raw.paymentAmount||0), customer:raw.ordererName||'', raw_json:'' }];
      default: return [{ id:`unk_${Date.now()}`, channel, order_id:'', order_date:'', status:'', product_name:'', product_no:'', variant_code:'', quantity:1, amount:0, customer:'', raw_json:'{}' }];
    }
  }

  _refreshDailySummary(channel) {
    this.db.run(`DELETE FROM daily_summary WHERE channel = ?`, [channel]);
    this.db.run(`INSERT INTO daily_summary (date, channel, order_count, total_amount, avg_order) SELECT order_date, channel, COUNT(*), SUM(amount), CASE WHEN COUNT(*)>0 THEN ROUND(SUM(amount)/COUNT(*)) ELSE 0 END FROM orders WHERE channel = ? AND order_date != '' GROUP BY order_date, channel`, [channel]);
  }

  // 매출 조회 (기존 유지)
  getSalesSummary(s, e) { return this.db.exec(`SELECT channel,COUNT(*),COALESCE(SUM(amount),0),CASE WHEN COUNT(*)>0 THEN ROUND(SUM(amount)/COUNT(*)) ELSE 0 END FROM orders WHERE order_date BETWEEN '${s}' AND '${e}' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status!='CANCELED' AND status!='RETURNED' GROUP BY channel`)[0]?.values?.map(r=>({channel:r[0],order_count:r[1],total_amount:r[2],avg_order:r[3]}))||[]; }
  getDailySales(s, e, ch) { let q=`SELECT order_date,channel,COUNT(*),COALESCE(SUM(amount),0) FROM orders WHERE order_date BETWEEN '${s}' AND '${e}' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status!='CANCELED' AND status!='RETURNED'`; if(ch&&ch!=='all')q+=` AND channel='${ch}'`; q+=' GROUP BY order_date,channel ORDER BY order_date'; return this.db.exec(q)[0]?.values?.map(r=>({date:r[0],channel:r[1],order_count:r[2],total_amount:r[3]}))||[]; }
  getTopProducts(s, e, l=20) { return this.db.exec(`SELECT product_name,channel,SUM(quantity),SUM(amount),COUNT(*) FROM orders WHERE order_date BETWEEN '${s}' AND '${e}' AND product_name!='' AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status!='CANCELED' AND status!='RETURNED' GROUP BY product_name,channel ORDER BY SUM(amount) DESC LIMIT ${l}`)[0]?.values?.map(r=>({product_name:r[0],channel:r[1],total_qty:r[2],total_amount:r[3],order_count:r[4]}))||[]; }
  getOrderCount() { return this.db.exec('SELECT COUNT(*) FROM orders')[0]?.values?.[0]?.[0]||0; }
  getOrderCountByChannel() { return this.db.exec('SELECT channel,COUNT(*) FROM orders GROUP BY channel')[0]?.values?.map(r=>({channel:r[0],count:r[1]}))||[]; }
  getRecentOrders(l=50, ch) { let q='SELECT id,channel,order_id,order_date,status,product_name,quantity,amount,customer,variant_code FROM orders'; if(ch&&ch!=='all')q+=` WHERE channel='${ch}'`; q+=` ORDER BY order_date DESC LIMIT ${l}`; return this.db.exec(q)[0]?.values?.map(r=>({id:r[0],channel:r[1],order_id:r[2],order_date:r[3],status:r[4],product_name:r[5],quantity:r[6],amount:r[7],customer:r[8],variant_code:r[9]||''}))||[]; }
  getDashboardData(s, e) { const sm=this.getSalesSummary(s,e);const dl=this.getDailySales(s,e);const tp=this.getTopProducts(s,e);const to=this.getOrderCount();const ch={};for(const r of sm)ch[r.channel]={channel:r.channel,revenue:r.total_amount,orders:r.order_count,avgOrder:r.avg_order};const dm={};for(const r of dl){if(!dm[r.date])dm[r.date]={date:r.date,카페24:0,쿠팡:0,네이버:0,total:0};dm[r.date][r.channel]=r.total_amount;dm[r.date].total+=r.total_amount;}const tr=sm.reduce((a,r)=>a+r.total_amount,0);const tc=sm.reduce((a,r)=>a+r.order_count,0);return{summary:{totalRevenue:tr,totalOrders:tc,avgOrderValue:tc>0?Math.round(tr/tc):0},channels:ch,dailySales:Object.values(dm).sort((a,b)=>a.date.localeCompare(b.date)),topProducts:tp,dbTotalOrders:to,fromDB:true}; }

  // 수집 이력
  saveCollectHistory(r) { this.db.run(`INSERT INTO collect_history (trigger_type,timestamp,duration,period_start,period_end,period_days,total_count,channels_json) VALUES (?,?,?,?,?,?,?,?)`, [r.trigger,r.timestamp,r.duration,r.period?.start||'',r.period?.end||'',r.period?.days||0,r.totalCount,JSON.stringify(r.channels)]); this._persist(); }
  getCollectHistory(l=20) { return this.db.exec(`SELECT id,trigger_type,timestamp,duration,period_start,period_end,period_days,total_count,channels_json FROM collect_history ORDER BY id DESC LIMIT ${l}`)[0]?.values?.map(r=>({id:r[0],trigger:r[1],timestamp:r[2],duration:r[3],period:{start:r[4],end:r[5],days:r[6]},totalCount:r[7],channels:JSON.parse(r[8]||'[]')}))||[]; }
  getStats() { const t=this.getOrderCount();const bc=this.getOrderCountByChannel();const dr=this.db.exec('SELECT MIN(order_date),MAX(order_date) FROM orders WHERE order_date!=""')[0]?.values?.[0]||[null,null];const hc=this.db.exec('SELECT COUNT(*) FROM collect_history')[0]?.values?.[0]?.[0]||0;const ic=this.db.exec('SELECT COUNT(*) FROM inventory')[0]?.values?.[0]?.[0]||0;return{totalOrders:t,byChannel:bc,dateRange:{from:dr[0],to:dr[1]},collectHistory:hc,inventoryProducts:ic,dbPath:DB_PATH,dbSize:fs.existsSync(DB_PATH)?Math.round(fs.statSync(DB_PATH).size/1024)+'KB':'0KB'}; }
  close() { this._persist(); if(this._saveInterval)clearInterval(this._saveInterval); }
}

module.exports = OrderDB;
