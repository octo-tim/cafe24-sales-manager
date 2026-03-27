/**
 * 멀티채널 통합 서비스 — 카페24 + 쿠팡 + 네이버 데이터 통합 분석
 */
class MultiChannelService {
  constructor({ cafe24Client, coupangClient, naverClient }) {
    this.cafe24 = cafe24Client;
    this.coupang = coupangClient;
    this.naver = naverClient;
    this._cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000;
  }

  _getCached(key) { const c = this._cache.get(key); if (c && Date.now() < c.expires) return c.data; return null; }
  _setCache(key, data) { this._cache.set(key, { data, expires: Date.now() + this.CACHE_TTL }); }

  async getIntegratedSalesAnalytics(startDate, endDate) {
    const cacheKey = `sales_${startDate}_${endDate}`;
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    const results = await Promise.allSettled([
      this._safe('cafe24', () => this.cafe24.getSalesAnalytics(startDate, endDate)),
      this._safe('coupang', () => this.coupang?.getSalesAnalytics(startDate, endDate)),
      this._safe('naver', () => this.naver?.getSalesAnalytics(startDate, endDate)),
    ]);

    const names = ['카페24', '쿠팡', '네이버'];
    const colors = ['#3266ad', '#e24b4a', '#1d9e75'];
    const channelData = results.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return { ...r.value, channel: names[i], color: colors[i], connected: true };
      return { channel: names[i], color: colors[i], connected: false, totalRevenue: 0, orderCount: 0, avgOrderValue: 0, dailySales: [], topProducts: [] };
    });

    const dailyMap = {};
    for (const ch of channelData) {
      for (const ds of ch.dailySales) {
        if (!dailyMap[ds.date]) dailyMap[ds.date] = { date: ds.date, 카페24: 0, 쿠팡: 0, 네이버: 0, total: 0 };
        dailyMap[ds.date][ch.channel] = ds.amount;
        dailyMap[ds.date].total += ds.amount;
      }
    }

    const productMap = {};
    for (const ch of channelData) {
      for (const p of ch.topProducts) {
        const key = p.productName || p.product_name || 'unknown';
        if (!productMap[key]) productMap[key] = { productName: key, totalQty: 0, totalRevenue: 0, channels: {} };
        productMap[key].totalQty += p.quantity || 0;
        productMap[key].totalRevenue += p.revenue || 0;
        productMap[key].channels[ch.channel] = { qty: p.quantity || 0, revenue: p.revenue || 0 };
      }
    }

    const totalRevenue = channelData.reduce((s, c) => s + c.totalRevenue, 0);
    const totalOrders = channelData.reduce((s, c) => s + c.orderCount, 0);

    const result = {
      period: { startDate, endDate },
      summary: { totalRevenue, totalOrders, avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0 },
      channels: channelData.map(c => ({
        channel: c.channel, color: c.color, connected: c.connected, revenue: c.totalRevenue, orders: c.orderCount, avgOrderValue: c.avgOrderValue,
        sharePercent: totalRevenue > 0 ? Math.round((c.totalRevenue / totalRevenue) * 1000) / 10 : 0,
      })),
      dailySales: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
      topProducts: Object.values(productMap).sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 30),
      generatedAt: new Date().toISOString(),
    };
    this._setCache(cacheKey, result);
    return result;
  }

  async getDashboardSummary() {
    const cacheKey = 'dashboard_summary';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const start = new Date(now.getTime() - 30 * 86400000).toISOString().substring(0, 10);
    const end = now.toISOString().substring(0, 10);
    const prevStart = new Date(now.getTime() - 60 * 86400000).toISOString().substring(0, 10);

    const [current, previous] = await Promise.all([
      this.getIntegratedSalesAnalytics(start, end),
      this.getIntegratedSalesAnalytics(prevStart, start).catch(() => null),
    ]);

    const trends = {};
    if (previous) {
      trends.revenue = previous.summary.totalRevenue > 0 ? Math.round(((current.summary.totalRevenue - previous.summary.totalRevenue) / previous.summary.totalRevenue) * 1000) / 10 : null;
      trends.orders = previous.summary.totalOrders > 0 ? Math.round(((current.summary.totalOrders - previous.summary.totalOrders) / previous.summary.totalOrders) * 1000) / 10 : null;
      trends.avgOrder = previous.summary.avgOrderValue > 0 ? Math.round(((current.summary.avgOrderValue - previous.summary.avgOrderValue) / previous.summary.avgOrderValue) * 1000) / 10 : null;
    }

    const result = { ...current, trends, previousPeriod: previous ? previous.summary : null };
    this._setCache(cacheKey, result);
    return result;
  }

  async getChannelStatus() {
    const checks = await Promise.allSettled([
      this._check('카페24', async () => { if (!this.cafe24?.tokens?.access_token) throw new Error('미인증'); await this.cafe24.getOrdersCount({}); }),
      this._check('쿠팡', async () => { if (!this.coupang?.config?.accessKey) throw new Error('미설정'); await this.coupang.getOrders({ maxPerPage: 1 }); }),
      this._check('네이버', async () => { if (!this.naver?.config?.clientId) throw new Error('미설정'); await this.naver.getProducts({ size: 1 }); }),
    ]);
    return checks.map(r => r.value || r.reason);
  }

  async _safe(name, fn) { try { return await fn(); } catch (e) { console.warn(`[MC] ${name}: ${e.message}`); return null; } }
  async _check(name, fn) { const s = Date.now(); try { await fn(); return { channel: name, status: 'connected', latency: Date.now() - s }; } catch (e) { return { channel: name, status: 'disconnected', error: e.message, latency: Date.now() - s }; } }
}

module.exports = MultiChannelService;
