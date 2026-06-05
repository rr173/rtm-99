const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const dispatchService = require('../services/dispatchService');
const hydraulicEngine = require('../services/hydraulicEngine');
const stateManager = require('../services/stateManager');
const siltationService = require('../services/siltationService');

function getCurrentInflowRate() {
  try {
    const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
    const gates = prepare('SELECT * FROM gates').all();
    const points = prepare('SELECT * FROM measurement_points').all();
    const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
    const segmentsForHydraulics = segments.map(seg => {
      if (underConstructionIds.includes(seg.id)) {
        return { ...seg, siltation_depth: seg.design_water_level };
      }
      return seg;
    });

    const firstGate = gates.find(g => g.position_on_segment <= 0.01 && g.canal_segment_id === segments[0].id);
    let headwaterDepth = 2.5;
    if (firstGate) {
      const gatePoints = points.filter(p => p.gate_id === firstGate.id && p.type === 'upstream_gate');
      if (gatePoints.length > 0) {
        const hwLevel = stateManager.getCurrentWaterLevel(gatePoints[0].id);
        if (hwLevel !== null) {
          headwaterDepth = hwLevel - segments[0].bottom_elevation;
        }
      }
    }

    const steadyState = hydraulicEngine.computeSteadyState(segmentsForHydraulics, gates, headwaterDepth);
    const firstSeg = segments[0];
    if (firstSeg && steadyState[firstSeg.id]) {
      return steadyState[firstSeg.id].flow;
    }
    return 5;
  } catch (err) {
    console.error('Get inflow rate error:', err);
    return 5;
  }
}

router.post('/irrigations', (req, res) => {
  try {
    const { name, gate_id, daily_quota, priority, min_flow, max_flow } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name 灌区名称不能为空' });
    }
    if (!gate_id) {
      return res.status(400).json({ error: 'gate_id 分水闸ID不能为空' });
    }
    if (daily_quota === undefined || daily_quota === null || isNaN(parseFloat(daily_quota)) || parseFloat(daily_quota) <= 0) {
      return res.status(400).json({ error: 'daily_quota 日配水配额必须是正数(m³)' });
    }
    if (priority === undefined || isNaN(parseInt(priority)) || parseInt(priority) < 1 || parseInt(priority) > 5) {
      return res.status(400).json({ error: 'priority 优先级必须是1-5之间的整数' });
    }
    if (min_flow === undefined || isNaN(parseFloat(min_flow)) || parseFloat(min_flow) < 0) {
      return res.status(400).json({ error: 'min_flow 最小流量需求必须是非负数(m³/s)' });
    }
    if (max_flow === undefined || isNaN(parseFloat(max_flow)) || parseFloat(max_flow) <= 0) {
      return res.status(400).json({ error: 'max_flow 最大允许流量必须是正数(m³/s)' });
    }
    if (parseFloat(min_flow) >= parseFloat(max_flow)) {
      return res.status(400).json({ error: 'min_flow 必须小于 max_flow' });
    }

    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(gate_id);
    if (!gate) {
      return res.status(404).json({ error: '分水闸不存在: ' + gate_id });
    }

    const irrigation = dispatchService.createIrrigation({
      name,
      gate_id,
      daily_quota,
      priority,
      min_flow,
      max_flow
    });

    res.json({
      success: true,
      message: '灌区创建成功',
      irrigation: irrigation
    });
  } catch (err) {
    console.error('Create irrigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/irrigations', (req, res) => {
  try {
    dispatchService.accumulateIrrigationsWaterUsage();
    const irrigations = dispatchService.getAllIrrigationsWithStatus();
    res.json({
      total: irrigations.length,
      irrigations: irrigations
    });
  } catch (err) {
    console.error('Get irrigations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/irrigations/:id', (req, res) => {
  try {
    const { id } = req.params;
    dispatchService.accumulateIrrigationsWaterUsage();
    const irrigations = dispatchService.getAllIrrigationsWithStatus();
    const irrigation = irrigations.find(i => i.id === parseInt(id));

    if (!irrigation) {
      return res.status(404).json({ error: '灌区不存在' });
    }

    res.json(irrigation);
  } catch (err) {
    console.error('Get irrigation detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/irrigations/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ error: '灌区不存在' });
    }

    const { name, gate_id, daily_quota, priority, min_flow, max_flow } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (!name) return res.status(400).json({ error: 'name 不能为空' });
      updateData.name = name;
    }

    if (gate_id !== undefined) {
      const gate = prepare('SELECT * FROM gates WHERE id = ?').get(gate_id);
      if (!gate) return res.status(404).json({ error: '分水闸不存在: ' + gate_id });
      updateData.gate_id = gate_id;
    }

    if (daily_quota !== undefined) {
      if (isNaN(parseFloat(daily_quota)) || parseFloat(daily_quota) <= 0) {
        return res.status(400).json({ error: 'daily_quota 必须是正数' });
      }
      updateData.daily_quota = daily_quota;
    }

    if (priority !== undefined) {
      if (isNaN(parseInt(priority)) || parseInt(priority) < 1 || parseInt(priority) > 5) {
        return res.status(400).json({ error: 'priority 必须是1-5之间的整数' });
      }
      updateData.priority = priority;
    }

    if (min_flow !== undefined) {
      if (isNaN(parseFloat(min_flow)) || parseFloat(min_flow) < 0) {
        return res.status(400).json({ error: 'min_flow 必须是非负数' });
      }
      updateData.min_flow = min_flow;
    }

    if (max_flow !== undefined) {
      if (isNaN(parseFloat(max_flow)) || parseFloat(max_flow) <= 0) {
        return res.status(400).json({ error: 'max_flow 必须是正数' });
      }
      updateData.max_flow = max_flow;
    }

    const updated = dispatchService.updateIrrigation(parseInt(id), updateData);

    res.json({
      success: true,
      message: '灌区更新成功',
      irrigation: updated
    });
  } catch (err) {
    console.error('Update irrigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/irrigations/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = dispatchService.deleteIrrigation(parseInt(id));

    if (!deleted) {
      return res.status(404).json({ error: '灌区不存在' });
    }

    res.json({
      success: true,
      message: '灌区删除成功'
    });
  } catch (err) {
    console.error('Delete irrigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/optimize', (req, res) => {
  try {
    const { inflow_rate } = req.body;
    let inflowRate;

    if (inflow_rate !== undefined && inflow_rate !== null) {
      inflowRate = parseFloat(inflow_rate);
      if (isNaN(inflowRate) || inflowRate < 0) {
        return res.status(400).json({ error: 'inflow_rate 渠首入流量必须是非负数(m³/s)' });
      }
    } else {
      inflowRate = getCurrentInflowRate();
    }

    const result = dispatchService.optimizeDispatch(inflowRate);
    const savedId = dispatchService.saveDispatchRecord(result._record, null);

    dispatchService.setLastOptimization({
      ...result,
      record_id: savedId
    });

    const safetyCheck = dispatchService.checkWaterLevelSafety(result.allocations);

    res.json({
      success: true,
      record_id: savedId,
      timestamp: Date.now(),
      inflow_rate: inflowRate,
      allocations: result.allocations,
      under_provisioned: result.under_provisioned,
      water_balance: result.water_balance,
      gate_plan: result.gate_plan,
      is_water_restriction_mode: result.is_water_restriction_mode,
      safety_preview: {
        safe: safetyCheck.safe,
        violations: safetyCheck.violations,
        warning: safetyCheck.warning
      }
    });
  } catch (err) {
    console.error('Optimize dispatch error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/apply', (req, res) => {
  try {
    const { record_id } = req.body;
    const recordId = record_id ? parseInt(record_id) : null;

    const result = dispatchService.applyDispatch(recordId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('Apply dispatch error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  try {
    const { days } = req.query;
    const history = dispatchService.getDispatchHistory(days);

    res.json({
      total: history.length,
      records: history
    });
  } catch (err) {
    console.error('Get dispatch history error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/daily-summary', (req, res) => {
  try {
    const summary = dispatchService.getDailySummary();
    res.json(summary);
  } catch (err) {
    console.error('Get daily summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
