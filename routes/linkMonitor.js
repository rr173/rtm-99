const express = require('express');
const router = express.Router();
const linkMonitorService = require('../services/linkMonitorService');

router.get('/status', (req, res) => {
  try {
    const statuses = linkMonitorService.getAllPointsStatus();
    res.json({
      success: true,
      timestamp: Date.now(),
      count: statuses.length,
      data: statuses
    });
  } catch (err) {
    console.error('Get all status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:pointId', (req, res) => {
  try {
    const { pointId } = req.params;
    const detail = linkMonitorService.getPointLinkDetail(pointId);
    
    if (!detail) {
      return res.status(404).json({ error: '测点不存在' });
    }
    
    res.json({
      success: true,
      timestamp: Date.now(),
      data: detail
    });
  } catch (err) {
    console.error('Get point status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/heartbeat', (req, res) => {
  try {
    const { heartbeats } = req.body;
    
    if (!Array.isArray(heartbeats)) {
      return res.status(400).json({ error: 'heartbeats 必须是数组' });
    }
    
    const result = linkMonitorService.recordHeartbeats(heartbeats);
    
    res.json({
      success: true,
      timestamp: Date.now(),
      ...result
    });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/quality/:pointId', (req, res) => {
  try {
    const { pointId } = req.params;
    const { hours } = req.query;
    const windowHours = hours ? parseInt(hours) : 6;
    
    if (isNaN(windowHours) || windowHours <= 0 || windowHours > 24) {
      return res.status(400).json({ error: 'hours 必须是1-24之间的整数' });
    }
    
    const diagnosis = linkMonitorService.diagnoseDataQuality(pointId, windowHours);
    
    if (!diagnosis) {
      return res.status(404).json({ error: '测点不存在' });
    }
    
    res.json({
      success: true,
      timestamp: Date.now(),
      data: diagnosis
    });
  } catch (err) {
    console.error('Quality diagnosis error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/quality', (req, res) => {
  try {
    const scores = linkMonitorService.getAllPointsQualityScores();
    res.json({
      success: true,
      timestamp: Date.now(),
      count: scores.length,
      data: scores
    });
  } catch (err) {
    console.error('Get all quality scores error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/report', (req, res) => {
  try {
    const report = linkMonitorService.generateHealthReport();
    res.json({
      success: true,
      timestamp: Date.now(),
      data: report
    });
  } catch (err) {
    console.error('Generate report error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/simulate-outage', (req, res) => {
  try {
    const { pointId, durationSeconds } = req.body;
    
    if (!pointId) {
      return res.status(400).json({ error: 'pointId 是必填项' });
    }
    
    const duration = durationSeconds ? parseInt(durationSeconds) : 300;
    if (isNaN(duration) || duration <= 0) {
      return res.status(400).json({ error: 'durationSeconds 必须是正整数' });
    }
    
    const result = linkMonitorService.simulateOutage(pointId, duration);
    
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    
    res.json({
      success: true,
      timestamp: Date.now(),
      data: result
    });
  } catch (err) {
    console.error('Simulate outage error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
