/**
 * ============================================================
 *  주문 데이터베이스 (sql.js — 순수 JS SQLite)
 * ============================================================
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'orders.db');

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
      const buf = fs.readFileSync(DB_PATH);
      this.db = new SQL.Database(buf);
      console.log(`[DB] 기존 DB 로드: ${DB_PATH}`);
    } else {
      this.db = new SQL.Database();
      console.log(`[DB] 새 DB 생성: ${DB_PATH}`);
    }
    this._migrate();
    this._saveInterval = setInterval(() => this._persist(), 30000);
  }

  async ensureReady() { await this._ready; }

  _migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        order_id TEXT NOT NULL,
        order_date TEXT NOT NULL,
        status TEXT DEFAULT '',
        product_name TEXT DEFAULT '',
        product_no TEXT DEFAULT '',
        quantity INTEGER DEFAULT 1,
        amount REAL DEFAULT 0,
        customer TEXT DEFAULT '',
        raw_json TEXT DEFAULT '{}',
        collected_at TEXT DEFAULT (datetime('now')),
        UNIQUE(channel, order_id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_ch_date ON orders(channel, order_date)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS collect_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        duration INTEGER DEFAULT 0,
        period_start TEXT,
        period_end TEXT,
        period_days INTEGER DEFAULT 0,
        total_count INTEGER DEFAULT 0,
        channels_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        date TEXT NOT NULL,
        channel TEXT NOT NULL,
        order_count INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        avg_order REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY(date, channel)
      )
    `);
  }

  _persist() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {
      console.warn('[DB] 저장 실패:', e.message);
    }
  }

  // ═══════════════════════════════════════════════
  //  주문 저장
  // ═══════════════════════════════════════════════

  saveOrders(channel, orders) {
    if (!orders || !orders.length) return { inserted: 0, total: 0 };
    let inserted = 0;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders (id, channel, order_id, order_date, status, product_name, product_no, quantity, amount, customer, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (const order of orders) {
      try {
        const n = this._normalizeOrder(channel, order);
        stmt.run([n.id, n.channel, n.order_id, n.order_date, n.status, n.product_name, n.product_no, n.quantity, n.amount, n.customer, n.raw_json]);
        inserted++;
      } catch (e) { /* 개별 실패 무시 */ }
    }
    stmt.free();
    this._refreshDailySummary(channel);
    this._persist();
    return { inserted, total: orders.length };
  }

  _normalizeOrder(channel, raw) {
    switch (channel) {
      case '카페24':
        return {
          id: `c24_${raw.order_id || raw.order_no || Date.now()}`,
          channel, order_id: String(raw.order_id || raw.order_no || ''),
          order_date: (raw.order_date || raw.created_date || '').substring(0, 10),
          status: raw.order_status || '',
          product_name: raw.items?.[0]?.product_name || '',
          product_no: String(raw.items?.[0]?.product_no || ''),
          quantity: raw.items?.reduce((s, i) => s + parseInt(i.quantity || 1), 0) || 1,
          amount: parseFloat(raw.payment_amount || raw.actual_payment_amount || raw.total_price || 0),
          customer: raw.buyer_name || '', raw_json: JSON.stringify(raw),
        };
      case '쿠팡':
        return {
          id: `cpg_${raw.orderId || raw.shipmentBoxId || Date.now()}`,
          channel, order_id: String(raw.orderId || raw.shipmentBoxId || ''),
          order_date: (raw.orderedAt || raw.createdAt || '').substring(0, 10),
          status: raw.status || '',
          product_name: raw.vendorItemName || '',
          product_no: String(raw.vendorItemId || ''),
          quantity: parseInt(raw.shippingCount || 1),
          amount: parseFloat(raw.orderPrice || raw.totalPrice || 0),
          customer: raw.receiver?.name || '', raw_json: JSON.stringify(raw),
        };
      case '네이버':
        return {
          id: `nvr_${raw.productOrderId || raw.orderId || Date.now()}`,
          channel, order_id: String(raw.productOrderId || raw.orderId || ''),
          order_date: (raw.orderDate || raw.paymentDate || '').substring(0, 10),
          status: raw._searchStatus || raw.productOrderStatus || '',
          product_name: raw.productName || '',
          product_no: String(raw.productId || ''),
          quantity: parseInt(raw.quantity || 1),
          amount: parseFloat(raw.totalPaymentAmount || raw.paymentAmount || 0),
          customer: raw.ordererName || '', raw_json: JSON.stringify(raw),
        };
      default:
        return { id: `unk_${Date.now()}`, channel, order_id: '', order_date: '', status: '', product_name: '', product_no: '', quantity: 1, amount: 0, customer: '', raw_json: '{}' };
    }
  }

  _refreshDailySummary(channel) {
    this.db.run(`DELETE FROM daily_summary WHERE channel = ?`, [channel]);
    this.db.run(`
      INSERT INTO daily_summary (date, channel, order_count, total_amount, avg_order)
      SELECT order_date, channel, COUNT(*), SUM(amount), CASE WHEN COUNT(*)>0 THEN ROUND(SUM(amount)/COUNT(*)) ELSE 0 END
      FROM orders WHERE channel = ? AND order_date != '' GROUP BY order_date, channel
    `, [channel]);
  }

  // ═══════════════════════════════════════════════
  //  매출 조회
  // ═══════════════════════════════════════════════

  getSalesSummary(startDate, endDate) {
    return this.db.exec(`
      SELECT channel, COUNT(*) as order_count, COALESCE(SUM(amount),0) as total_amount,
        CASE WHEN COUNT(*)>0 THEN ROUND(SUM(amount)/COUNT(*)) ELSE 0 END as avg_order
      FROM orders WHERE order_date BETWEEN '${startDate}' AND '${endDate}'
        AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' AND status != 'RETURNED'
      GROUP BY channel
    `)[0]?.values?.map(r => ({ channel: r[0], order_count: r[1], total_amount: r[2], avg_order: r[3] })) || [];
  }

  getDailySales(startDate, endDate, channel) {
    let sql = `SELECT order_date, channel, COUNT(*), COALESCE(SUM(amount),0)
      FROM orders WHERE order_date BETWEEN '${startDate}' AND '${endDate}'
      AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' AND status != 'RETURNED'`;
    if (channel && channel !== 'all') sql += ` AND channel = '${channel}'`;
    sql += ' GROUP BY order_date, channel ORDER BY order_date';
    return this.db.exec(sql)[0]?.values?.map(r => ({ date: r[0], channel: r[1], order_count: r[2], total_amount: r[3] })) || [];
  }

  getTopProducts(startDate, endDate, limit = 20) {
    return this.db.exec(`
      SELECT product_name, channel, SUM(quantity), SUM(amount), COUNT(*)
      FROM orders WHERE order_date BETWEEN '${startDate}' AND '${endDate}' AND product_name != ''
        AND status NOT LIKE 'C%' AND status NOT LIKE 'R%' AND status != 'CANCELED' AND status != 'RETURNED'
      GROUP BY product_name, channel ORDER BY SUM(amount) DESC LIMIT ${limit}
    `)[0]?.values?.map(r => ({ product_name: r[0], channel: r[1], total_qty: r[2], total_amount: r[3], order_count: r[4] })) || [];
  }

  getOrderCount() {
    return this.db.exec('SELECT COUNT(*) FROM orders')[0]?.values?.[0]?.[0] || 0;
  }

  getOrderCountByChannel() {
    return this.db.exec('SELECT channel, COUNT(*) FROM orders GROUP BY channel')[0]?.values?.map(r => ({ channel: r[0], count: r[1] })) || [];
  }

  getRecentOrders(limit = 50, channel) {
    let sql = 'SELECT id, channel, order_id, order_date, status, product_name, quantity, amount, customer FROM orders';
    if (channel && channel !== 'all') sql += ` WHERE channel = '${channel}'`;
    sql += ` ORDER BY order_date DESC LIMIT ${limit}`;
    return this.db.exec(sql)[0]?.values?.map(r => ({ id:r[0], channel:r[1], order_id:r[2], order_date:r[3], status:r[4], product_name:r[5], quantity:r[6], amount:r[7], customer:r[8] })) || [];
  }

  getDashboardData(startDate, endDate) {
    const summary = this.getSalesSummary(startDate, endDate);
    const daily = this.getDailySales(startDate, endDate);
    const topProducts = this.getTopProducts(startDate, endDate);
    const totalOrders = this.getOrderCount();

    const channels = {};
    for (const r of summary) channels[r.channel] = { channel: r.channel, revenue: r.total_amount, orders: r.order_count, avgOrder: r.avg_order };

    const dailyMap = {};
    for (const r of daily) {
      if (!dailyMap[r.date]) dailyMap[r.date] = { date: r.date, 카페24: 0, 쿠팡: 0, 네이버: 0, total: 0 };
      dailyMap[r.date][r.channel] = r.total_amount;
      dailyMap[r.date].total += r.total_amount;
    }

    const totalRevenue = summary.reduce((s, r) => s + r.total_amount, 0);
    const totalOrd = summary.reduce((s, r) => s + r.order_count, 0);

    return {
      summary: { totalRevenue, totalOrders: totalOrd, avgOrderValue: totalOrd > 0 ? Math.round(totalRevenue / totalOrd) : 0 },
      channels, dailySales: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
      topProducts, dbTotalOrders: totalOrders, fromDB: true,
    };
  }

  // ═══════════════════════════════════════════════
  //  수집 이력
  // ═══════════════════════════════════════════════

  saveCollectHistory(record) {
    this.db.run(`INSERT INTO collect_history (trigger_type,timestamp,duration,period_start,period_end,period_days,total_count,channels_json) VALUES (?,?,?,?,?,?,?,?)`,
      [record.trigger, record.timestamp, record.duration, record.period?.start||'', record.period?.end||'', record.period?.days||0, record.totalCount, JSON.stringify(record.channels)]);
    this._persist();
  }

  getCollectHistory(limit = 20) {
    return this.db.exec(`SELECT id,trigger_type,timestamp,duration,period_start,period_end,period_days,total_count,channels_json FROM collect_history ORDER BY id DESC LIMIT ${limit}`)[0]?.values?.map(r => ({
      id: r[0], trigger: r[1], timestamp: r[2], duration: r[3],
      period: { start: r[4], end: r[5], days: r[6] }, totalCount: r[7], channels: JSON.parse(r[8] || '[]'),
    })) || [];
  }

  getStats() {
    const total = this.getOrderCount();
    const byChannel = this.getOrderCountByChannel();
    const dateRange = this.db.exec('SELECT MIN(order_date), MAX(order_date) FROM orders WHERE order_date != ""')[0]?.values?.[0] || [null, null];
    const historyCount = this.db.exec('SELECT COUNT(*) FROM collect_history')[0]?.values?.[0]?.[0] || 0;

    return {
      totalOrders: total, byChannel,
      dateRange: { from: dateRange[0], to: dateRange[1] },
      collectHistory: historyCount, dbPath: DB_PATH,
      dbSize: fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) + 'KB' : '0KB',
    };
  }

  close() { this._persist(); if (this._saveInterval) clearInterval(this._saveInterval); }
}

module.exports = OrderDB;
