/**
 * ============================================================
 *  주문 데이터베이스 (SQLite)
 * ============================================================
 *  - 수집된 주문을 로컬 DB에 저장
 *  - 채널별/기간별 매출 집계를 DB 쿼리로 즉시 반환
 *  - 수집 이력도 DB에 영구 저장
 * ============================================================
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'orders.db');

class OrderDB {
  constructor() {
    // data 디렉토리 생성
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    console.log(`[DB] SQLite 연결: ${DB_PATH}`);
  }

  // ─── 테이블 생성 ───
  _migrate() {
    this.db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel);
      CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
      CREATE INDEX IF NOT EXISTS idx_orders_channel_date ON orders(channel, order_date);

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
      );

      CREATE TABLE IF NOT EXISTS daily_summary (
        date TEXT NOT NULL,
        channel TEXT NOT NULL,
        order_count INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        avg_order REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY(date, channel)
      );
    `);
  }

  // ═══════════════════════════════════════════════
  //  주문 저장 (UPSERT)
  // ═══════════════════════════════════════════════

  /**
   * 주문 배열을 DB에 저장 (중복 시 업데이트)
   * @param {string} channel - '카페24' | '쿠팡' | '네이버'
   * @param {Array} orders - 주문 객체 배열
   * @returns {Object} { inserted, updated, total }
   */
  saveOrders(channel, orders) {
    if (!orders || !orders.length) return { inserted: 0, updated: 0, total: 0 };

    const upsert = this.db.prepare(`
      INSERT INTO orders (id, channel, order_id, order_date, status, product_name, product_no, quantity, amount, customer, raw_json)
      VALUES (@id, @channel, @order_id, @order_date, @status, @product_name, @product_no, @quantity, @amount, @customer, @raw_json)
      ON CONFLICT(channel, order_id) DO UPDATE SET
        status = @status,
        amount = @amount,
        quantity = @quantity,
        raw_json = @raw_json,
        collected_at = datetime('now')
    `);

    let inserted = 0, updated = 0;

    const tx = this.db.transaction((items) => {
      for (const order of items) {
        const normalized = this._normalizeOrder(channel, order);
        const info = upsert.run(normalized);
        if (info.changes > 0) {
          inserted++;
        }
      }
    });

    tx(orders);

    // 일별 요약 갱신
    this._refreshDailySummary(channel);

    return { inserted, updated: 0, total: orders.length };
  }

  // ─── 채널별 주문 정규화 ───
  _normalizeOrder(channel, raw) {
    switch (channel) {
      case '카페24':
        return {
          id: `c24_${raw.order_id || raw.order_no || Date.now()}`,
          channel,
          order_id: String(raw.order_id || raw.order_no || ''),
          order_date: (raw.order_date || raw.created_date || '').substring(0, 10),
          status: raw.order_status || '',
          product_name: raw.items?.[0]?.product_name || raw.product_name || '',
          product_no: String(raw.items?.[0]?.product_no || raw.product_no || ''),
          quantity: raw.items?.reduce((s, i) => s + parseInt(i.quantity || 1), 0) || 1,
          amount: parseFloat(raw.payment_amount || raw.actual_payment_amount || raw.total_amount_paid || raw.total_price || 0),
          customer: raw.buyer_name || raw.buyer_email || '',
          raw_json: JSON.stringify(raw),
        };

      case '쿠팡':
        return {
          id: `cpg_${raw.orderId || raw.shipmentBoxId || Date.now()}`,
          channel,
          order_id: String(raw.orderId || raw.shipmentBoxId || ''),
          order_date: (raw.orderedAt || raw.createdAt || '').substring(0, 10),
          status: raw.status || '',
          product_name: raw.vendorItemName || '',
          product_no: String(raw.vendorItemId || ''),
          quantity: parseInt(raw.shippingCount || 1),
          amount: parseFloat(raw.orderPrice || raw.totalPrice || 0),
          customer: raw.receiver?.name || '',
          raw_json: JSON.stringify(raw),
        };

      case '네이버':
        return {
          id: `nvr_${raw.productOrderId || raw.orderId || Date.now()}`,
          channel,
          order_id: String(raw.productOrderId || raw.orderId || ''),
          order_date: (raw.orderDate || raw.paymentDate || '').substring(0, 10),
          status: raw._searchStatus || raw.productOrderStatus || '',
          product_name: raw.productName || '',
          product_no: String(raw.productId || ''),
          quantity: parseInt(raw.quantity || 1),
          amount: parseFloat(raw.totalPaymentAmount || raw.paymentAmount || raw.totalProductAmount || 0),
          customer: raw.ordererName || '',
          raw_json: JSON.stringify(raw),
        };

      default:
        return {
          id: `unk_${Date.now()}_${Math.random().toString(36).substring(2,8)}`,
          channel,
          order_id: String(raw.id || raw.order_id || ''),
          order_date: new Date().toISOString().substring(0, 10),
          status: '',
          product_name: '',
          product_no: '',
          quantity: 1,
          amount: 0,
          customer: '',
          raw_json: JSON.stringify(raw),
        };
    }
  }

  // ─── 일별 요약 갱신 ───
  _refreshDailySummary(channel) {
    this.db.exec(`
      INSERT OR REPLACE INTO daily_summary (date, channel, order_count, total_amount, avg_order, updated_at)
      SELECT
        order_date as date,
        channel,
        COUNT(*) as order_count,
        SUM(amount) as total_amount,
        CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(amount) / COUNT(*)) ELSE 0 END as avg_order,
        datetime('now') as updated_at
      FROM orders
      WHERE channel = '${channel}' AND order_date != ''
      GROUP BY order_date, channel
    `);
  }


  // ═══════════════════════════════════════════════
  //  매출 조회 (DB에서 즉시 반환)
  // ═══════════════════════════════════════════════

  /** 기간별 채널별 매출 요약 */
  getSalesSummary(startDate, endDate) {
    const rows = this.db.prepare(`
      SELECT channel,
        COUNT(*) as order_count,
        COALESCE(SUM(amount), 0) as total_amount,
        CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(amount) / COUNT(*)) ELSE 0 END as avg_order
      FROM orders
      WHERE order_date BETWEEN ? AND ?
        AND status NOT LIKE 'C%' AND status NOT LIKE 'R%'
        AND status != 'CANCELED' AND status != 'RETURNED'
      GROUP BY channel
    `).all(startDate, endDate);

    return rows;
  }

  /** 일별 채널별 매출 */
  getDailySales(startDate, endDate, channel) {
    let sql = `
      SELECT order_date as date, channel,
        COUNT(*) as order_count,
        COALESCE(SUM(amount), 0) as total_amount
      FROM orders
      WHERE order_date BETWEEN ? AND ?
        AND status NOT LIKE 'C%' AND status NOT LIKE 'R%'
        AND status != 'CANCELED' AND status != 'RETURNED'
    `;
    const params = [startDate, endDate];
    if (channel && channel !== 'all') {
      sql += ' AND channel = ?';
      params.push(channel);
    }
    sql += ' GROUP BY order_date, channel ORDER BY order_date';
    return this.db.prepare(sql).all(...params);
  }

  /** 상품별 매출 TOP N */
  getTopProducts(startDate, endDate, limit = 20) {
    return this.db.prepare(`
      SELECT product_name, product_no, channel,
        SUM(quantity) as total_qty,
        SUM(amount) as total_amount,
        COUNT(*) as order_count
      FROM orders
      WHERE order_date BETWEEN ? AND ?
        AND product_name != ''
        AND status NOT LIKE 'C%' AND status NOT LIKE 'R%'
        AND status != 'CANCELED' AND status != 'RETURNED'
      GROUP BY product_name, channel
      ORDER BY total_amount DESC
      LIMIT ?
    `).all(startDate, endDate, limit);
  }

  /** 전체 주문 건수 */
  getOrderCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  }

  /** 채널별 주문 건수 */
  getOrderCountByChannel() {
    return this.db.prepare('SELECT channel, COUNT(*) as count FROM orders GROUP BY channel').all();
  }

  /** 최근 주문 목록 */
  getRecentOrders(limit = 50, channel) {
    let sql = 'SELECT id, channel, order_id, order_date, status, product_name, quantity, amount, customer FROM orders';
    const params = [];
    if (channel && channel !== 'all') {
      sql += ' WHERE channel = ?';
      params.push(channel);
    }
    sql += ' ORDER BY order_date DESC, collected_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  /** 통합 대시보드 데이터 (DB에서 즉시) */
  getDashboardData(startDate, endDate) {
    const summary = this.getSalesSummary(startDate, endDate);
    const daily = this.getDailySales(startDate, endDate);
    const topProducts = this.getTopProducts(startDate, endDate);
    const totalOrders = this.getOrderCount();

    // 채널별 집계
    const channels = {};
    for (const row of summary) {
      channels[row.channel] = {
        channel: row.channel,
        revenue: row.total_amount,
        orders: row.order_count,
        avgOrder: row.avg_order,
      };
    }

    // 일별 데이터 피벗
    const dailyMap = {};
    for (const row of daily) {
      if (!dailyMap[row.date]) dailyMap[row.date] = { date: row.date, 카페24: 0, 쿠팡: 0, 네이버: 0, total: 0 };
      dailyMap[row.date][row.channel] = row.total_amount;
      dailyMap[row.date].total += row.total_amount;
    }
    const dailySales = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const totalRevenue = summary.reduce((s, r) => s + r.total_amount, 0);
    const totalOrd = summary.reduce((s, r) => s + r.order_count, 0);

    return {
      summary: { totalRevenue, totalOrders: totalOrd, avgOrderValue: totalOrd > 0 ? Math.round(totalRevenue / totalOrd) : 0 },
      channels,
      dailySales,
      topProducts,
      dbTotalOrders: totalOrders,
      fromDB: true,
    };
  }


  // ═══════════════════════════════════════════════
  //  수집 이력 저장/조회
  // ═══════════════════════════════════════════════

  saveCollectHistory(record) {
    this.db.prepare(`
      INSERT INTO collect_history (trigger_type, timestamp, duration, period_start, period_end, period_days, total_count, channels_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.trigger,
      record.timestamp,
      record.duration,
      record.period?.start || '',
      record.period?.end || '',
      record.period?.days || 0,
      record.totalCount,
      JSON.stringify(record.channels),
    );
  }

  getCollectHistory(limit = 20) {
    const rows = this.db.prepare(`
      SELECT * FROM collect_history ORDER BY id DESC LIMIT ?
    `).all(limit);

    return rows.map(r => ({
      id: r.id,
      trigger: r.trigger_type,
      timestamp: r.timestamp,
      duration: r.duration,
      period: { start: r.period_start, end: r.period_end, days: r.period_days },
      totalCount: r.total_count,
      channels: JSON.parse(r.channels_json || '[]'),
    }));
  }

  /** DB 통계 */
  getStats() {
    const total = this.getOrderCount();
    const byChannel = this.getOrderCountByChannel();
    const dateRange = this.db.prepare('SELECT MIN(order_date) as min_date, MAX(order_date) as max_date FROM orders WHERE order_date != ""').get();
    const historyCount = this.db.prepare('SELECT COUNT(*) as count FROM collect_history').get().count;

    return {
      totalOrders: total,
      byChannel,
      dateRange: { from: dateRange?.min_date, to: dateRange?.max_date },
      collectHistory: historyCount,
      dbPath: DB_PATH,
      dbSize: fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) + 'KB' : '0KB',
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = OrderDB;
