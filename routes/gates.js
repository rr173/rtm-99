const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const stateManager = require('../services/stateManager');
const hydraulicEngine = require('../services/hydraulicEngine');
const siltationService = require('../services/siltationService');
const iceService = require('../services/iceService');

function getSteadyStateDischarge(gate) {
  let segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();

  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  segments = segments.map(seg => {
    if (underConstructionIds.includes(seg.id)) {
      return { ...seg, siltation_depth: seg.design_water_level };
    }
    return seg;
  });

  segments = iceService.applyIceAdjustmentsToSegments(segments);

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

  const steadyState = hydraulicEngine.computeSteadyState(segments, gates, headwaterDepth);
  const seg = segments.find(s => s.id === gate.canal_segment_id);
  const ss = seg ? steadyState[seg.id] : null;

  if (!ss) return 0;
  if (gate.type === 'diversion') return ss.diversionFlow;
  return ss.flow;
}

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(id);
    if (!gate) {
      return res.status(404).json({ error: '闸门不存在' });
    }
    
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(gate.canal_segment_id);
    const points = prepare('SELECT * FROM measurement_points WHERE gate_id = ?').all(id);
    const upPoint = points.find(p => p.type === 'upstream_gate');
    const downPoint = points.find(p => p.type === 'downstream_gate');
    
    const hUp = upPoint ? stateManager.getCurrentWaterLevel(upPoint.id) : null;
    const hDown = downPoint ? stateManager.getCurrentWaterLevel(downPoint.id) : null;
    
    const discharge = getSteadyStateDischarge(gate);
    
    const lockInfo = stateManager.getGateLockInfo(id);
    
    res.json({
      ...gate,
      currentUpstreamLevel: hUp,
      currentDownstreamLevel: hDown,
      currentUpstreamDepth: hUp !== null && seg ? hUp - seg.bottom_elevation : null,
      currentDownstreamDepth: hDown !== null && seg ? hDown - seg.bottom_elevation : null,
      currentDischarge: Math.round(discharge * 1000) / 1000,
      upstreamPointId: upPoint?.id,
      downstreamPointId: downPoint?.id,
      locked: lockInfo.locked,
      lockInfo: lockInfo
    });
  } catch (err) {
    console.error('Get gate error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { opening } = req.body;
    
    if (opening === undefined || typeof opening !== 'number') {
      return res.status(400).json({ error: '开度值必须是数字' });
    }
    
    if (stateManager.isGateLocked(id)) {
      const lockInfo = stateManager.getGateLockInfo(id);
      return res.status(403).json({ 
        error: '该闸门因维护计划锁定中',
        lockInfo: lockInfo
      });
    }
    
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(id);
    if (!gate) {
      return res.status(404).json({ error: '闸门不存在' });
    }
    
    if (opening < 0 || opening > gate.max_opening) {
      return res.status(400).json({ 
        error: `开度必须在 0 到 ${gate.max_opening} 之间` 
      });
    }
    
    const newOpening = stateManager.updateGateOpening(id, opening);
    
    const updatedGate = prepare('SELECT * FROM gates WHERE id = ?').get(id);
    const discharge = getSteadyStateDischarge(updatedGate);
    
    res.json({
      success: true,
      message: `闸门 ${gate.name} 开度已调整`,
      previousOpening: gate.current_opening,
      currentOpening: newOpening,
      currentDischarge: Math.round(discharge * 1000) / 1000,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Update gate error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/target-opening', (req, res) => {
  try {
    const { id } = req.params;
    const { opening } = req.body;
    
    if (opening === undefined || typeof opening !== 'number') {
      return res.status(400).json({ error: '开度值必须是数字' });
    }
    
    if (stateManager.isGateLocked(id)) {
      const lockInfo = stateManager.getGateLockInfo(id);
      return res.status(403).json({ 
        error: '该闸门因维护计划锁定中',
        lockInfo: lockInfo
      });
    }
    
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(id);
    if (!gate) {
      return res.status(404).json({ error: '闸门不存在' });
    }
    
    const targetOpening = stateManager.setGateTargetOpening(id, opening);
    
    res.json({
      success: true,
      message: `闸门 ${gate.name} 目标开度已设置 (用于测试闸门故障)`,
      targetOpening: targetOpening,
      currentOpening: gate.current_opening,
      deviation: Math.abs(gate.current_opening - targetOpening),
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Set gate target opening error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
