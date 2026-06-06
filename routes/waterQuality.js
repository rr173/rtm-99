const express = require('express');
const router = express.Router();
const waterQualityService = require('../services/waterQualityService');

router.post('/report', (req, res) => {
  try {
    const { pointId, turbidity, dissolvedOxygen, ph, timestamp } = req.body;

    const result = waterQualityService.reportWaterQuality(
      pointId,
      parseFloat(turbidity),
      parseFloat(dissolvedOxygen),
      parseFloat(ph),
      timestamp ? parseInt(timestamp) : null
    );

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (err) {
    console.error('Report water quality error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', (req, res) => {
  try {
    const statuses = waterQualityService.getAllSegmentStatus();
    res.json({
      queryTime: Date.now(),
      totalSegments: statuses.length,
      segments: statuses,
      thresholds: {
        alarm: waterQualityService.ALARM_THRESHOLDS,
        warning: waterQualityService.WARNING_THRESHOLDS
      }
    });
  } catch (err) {
    console.error('Get water quality status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:segmentId', (req, res) => {
  try {
    const { segmentId } = req.params;
    const detail = waterQualityService.getSegmentStatusDetail(segmentId);

    if (detail.error) {
      return res.status(404).json({ error: detail.error });
    }

    res.json(detail);
  } catch (err) {
    console.error('Get segment water quality detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/lockdowns', (req, res) => {
  try {
    const lockdowns = waterQualityService.getActiveLockdowns();
    res.json({
      queryTime: Date.now(),
      totalActive: lockdowns.length,
      lockdowns
    });
  } catch (err) {
    console.error('Get water quality lockdowns error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/events', (req, res) => {
  try {
    const { segmentId, startTime, endTime, status } = req.query;
    const filters = {};
    if (segmentId) filters.segmentId = segmentId;
    if (startTime) filters.startTime = startTime;
    if (endTime) filters.endTime = endTime;
    if (status) filters.status = status;

    const result = waterQualityService.getEventList(filters);
    res.json(result);
  } catch (err) {
    console.error('Get water quality events error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/events/:id', (req, res) => {
  try {
    const { id } = req.params;
    const detail = waterQualityService.getEventDetail(id);

    if (detail.error) {
      return res.status(404).json({ error: detail.error });
    }

    res.json(detail);
  } catch (err) {
    console.error('Get water quality event detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
