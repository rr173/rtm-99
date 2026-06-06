const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const iceService = require('../services/iceService');

function getOperatorFromRequest(req) {
  return req.get('X-Operator') || 'system';
}

router.post('/temperature', (req, res) => {
  try {
    const { pointId, airTemperature, waterTemperature, timestamp } = req.body;

    if (!pointId) {
      return res.status(400).json({ error: '缺少测点ID (pointId)' });
    }
    if (typeof airTemperature !== 'number') {
      return res.status(400).json({ error: '气温必须是数字 (airTemperature, 单位℃)' });
    }
    if (typeof waterTemperature !== 'number') {
      return res.status(400).json({ error: '水温必须是数字 (waterTemperature, 单位℃)' });
    }

    const point = prepare('SELECT * FROM measurement_points WHERE id = ?').get(pointId);
    if (!point) {
      return res.status(404).json({ error: `测点不存在: ${pointId}` });
    }

    const result = iceService.recordTemperature(pointId, airTemperature, waterTemperature, timestamp);

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (err) {
    console.error('Report temperature error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', (req, res) => {
  try {
    const statuses = iceService.getAllSegmentStatus();
    res.json({
      queryTime: Date.now(),
      totalSegments: statuses.length,
      segments: statuses
    });
  } catch (err) {
    console.error('Get ice status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:segmentId', (req, res) => {
  try {
    const { segmentId } = req.params;
    const detail = iceService.getSegmentStatusDetail(segmentId);

    if (detail.error) {
      return res.status(404).json({ error: detail.error });
    }

    res.json(detail);
  } catch (err) {
    console.error('Get segment ice detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/hydraulic-adjustment', (req, res) => {
  try {
    const adjustments = iceService.getHydraulicAdjustments();
    res.json(adjustments);
  } catch (err) {
    console.error('Get hydraulic adjustment error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/recommendations', (req, res) => {
  try {
    const result = iceService.getRecommendations();
    res.json(result);
  } catch (err) {
    console.error('Get ice recommendations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/apply-recommendations', (req, res) => {
  try {
    const operator = getOperatorFromRequest(req);
    const result = iceService.applyRecommendations(operator);
    res.json(result);
  } catch (err) {
    console.error('Apply ice recommendations error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
