const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const siltationService = require('../services/siltationService');

router.post('/simulate', (req, res) => {
  try {
    const { days, rates } = req.body;

    if (!days || typeof days !== 'number' || days < 1 || days > 3650) {
      return res.status(400).json({ error: '时间跨度天数必须为1-3650之间的整数' });
    }
    if (!rates || typeof rates !== 'object') {
      return res.status(400).json({ error: 'rates 必须是对象, 包含各渠段ID对应的日淤积速率(mm/天)或 default 字段' });
    }

    const startTime = Date.now();
    const result = siltationService.simulateSiltation({ days, rates });
    const computeTime = Date.now() - startTime;

    res.json({
      ...result,
      computeTimeMs: computeTime
    });
  } catch (err) {
    console.error('Siltation simulate error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/plan', (req, res) => {
  try {
    const plan = siltationService.getDredgingPlan();
    res.json(plan);
  } catch (err) {
    console.error('Dredging plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/work-orders', (req, res) => {
  try {
    const { segmentIds, plannedDate, targetSiltation } = req.body;

    if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
      return res.status(400).json({ error: 'segmentIds 必须是非空数组' });
    }
    if (!plannedDate || typeof plannedDate !== 'string') {
      return res.status(400).json({ error: 'plannedDate 必须是日期字符串(YYYY-MM-DD)' });
    }

    for (const segId of segmentIds) {
      const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segId);
      if (!seg) {
        return res.status(404).json({ error: `渠段不存在: ${segId}` });
      }
    }

    const orders = siltationService.createWorkOrders(segmentIds, plannedDate, targetSiltation);
    if (orders.length === 0) {
      return res.status(400).json({ error: '所选渠段已有进行中的清淤工单' });
    }

    res.json({
      success: true,
      createdCount: orders.length,
      orders: orders
    });
  } catch (err) {
    console.error('Create work orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/work-orders/:id/complete', (req, res) => {
  try {
    const { id } = req.params;
    const result = siltationService.completeWorkOrder(parseInt(id));

    if (!result) {
      return res.status(404).json({ error: '工单不存在' });
    }
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Complete work order error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/work-orders', (req, res) => {
  try {
    const { status, segmentId } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (segmentId) filters.segmentId = segmentId;

    const orders = siltationService.getWorkOrders(filters);
    res.json({
      total: orders.length,
      orders: orders
    });
  } catch (err) {
    console.error('Get work orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
