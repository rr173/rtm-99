const express = require('express');
const router = express.Router();
const waterBalanceService = require('../services/waterBalanceService');

router.post('/calculate', (req, res) => {
  try {
    const { windowMinutes } = req.query;
    const window = windowMinutes !== undefined ? parseInt(windowMinutes) : 30;
    
    if (isNaN(window) || window < 10 || window > 360) {
      return res.status(400).json({ error: 'windowMinutes 必须在 10 到 360 分钟之间' });
    }
    
    const result = waterBalanceService.calculateWaterBalance(window);
    
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Calculate water balance error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/leakage-analysis', (req, res) => {
  try {
    const result = waterBalanceService.getLeakageAnalysis();
    res.json(result);
  } catch (err) {
    console.error('Leakage analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  try {
    const { segmentId, days } = req.query;
    
    if (!segmentId) {
      return res.status(400).json({ error: 'segmentId 不能为空' });
    }
    
    const daysParam = days !== undefined ? parseInt(days) : 7;
    if (isNaN(daysParam) || daysParam < 1 || daysParam > 365) {
      return res.status(400).json({ error: 'days 必须在 1 到 365 天之间' });
    }
    
    const result = waterBalanceService.getSegmentHistory(segmentId, daysParam);
    
    if (result.error) {
      return res.status(404).json({ error: result.error });
    }
    
    res.json(result);
  } catch (err) {
    console.error('Get history error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/daily-report', (req, res) => {
  try {
    const result = waterBalanceService.getDailyReport();
    res.json(result);
  } catch (err) {
    console.error('Daily report error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/threshold', (req, res) => {
  try {
    const { segmentId, warningThreshold, alarmThreshold } = req.body;
    
    if (!segmentId) {
      return res.status(400).json({ error: 'segmentId 不能为空' });
    }
    
    const result = waterBalanceService.setSegmentThreshold(
      segmentId,
      parseFloat(warningThreshold),
      parseFloat(alarmThreshold)
    );
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
  } catch (err) {
    console.error('Set threshold error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/thresholds', (req, res) => {
  try {
    const thresholds = waterBalanceService.getAllThresholds();
    res.json({
      total: thresholds.length,
      thresholds: thresholds
    });
  } catch (err) {
    console.error('Get thresholds error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
