/**
 * 멀티채널 API 라우터 — /api/multichannel/*
 */
const express = require('express');
const router = express.Router();

module.exports = function (multiChannelService) {
  router.get('/dashboard', async (req, res) => {
    try { res.json({ success: true, data: await multiChannelService.getDashboardSummary() }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/sales', async (req, res) => {
    try {
      const { start_date, end_date } = req.query;
      if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'start_date, end_date 필수' });
      res.json({ success: true, data: await multiChannelService.getIntegratedSalesAnalytics(start_date, end_date) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/channels', async (req, res) => {
    try { res.json({ success: true, data: await multiChannelService.getChannelStatus() }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
};
