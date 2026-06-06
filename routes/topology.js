const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const stateManager = require('../services/stateManager');
const hydraulicEngine = require('../services/hydraulicEngine');
const siltationService = require('../services/siltationService');
const iceService = require('../services/iceService');

router.put('/:id/siltation', (req, res) => {
  try {
    const { id } = req.params;
    const { siltationDepth } = req.body;

    if (siltationDepth === undefined || typeof siltationDepth !== 'number' || siltationDepth < 0) {
      return res.status(400).json({ error: 'siltationDepth 必须是非负数字(单位:m)' });
    }

    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(id);
    if (!seg) {
      return res.status(404).json({ error: '渠段不存在' });
    }

    const result = siltationService.setSiltationDepth(id, siltationDepth);
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Set siltation depth error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const segments = prepare(`
      SELECT * FROM canal_segments ORDER BY order_index
    `).all();
    
    const gates = prepare(`
      SELECT * FROM gates
    `).all();
    
    const nodes = prepare(`
      SELECT * FROM nodes
    `).all();
    
    const points = prepare(`
      SELECT * FROM measurement_points ORDER BY canal_segment_id, distance_from_upstream
    `).all();

    const underConstructionIds = siltationService.getUnderConstructionSegmentIds();

    let segmentsForHydraulics = segments.map(seg => {
      if (underConstructionIds.includes(seg.id)) {
        return { ...seg, siltation_depth: seg.design_water_level };
      }
      return seg;
    });

    segmentsForHydraulics = iceService.applyIceAdjustmentsToSegments(segmentsForHydraulics);

    const iceAdjustments = iceService.getHydraulicAdjustments();

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

    const segmentsWithStatus = segments.map(seg => {
      const segLevels = stateManager.getSegmentWaterLevels(seg.id);
      const safetyLow = seg.bottom_elevation + 0.3;
      const safetyHigh = seg.bottom_elevation + seg.design_water_level * 0.9;
      const sd = seg.siltation_depth || 0;
      const Qdesign = siltationService.getDesignFlow(seg);
      const Qcap = siltationService.getCapacityFlow(seg, sd);
      const capacityRatio = Qdesign > 0 ? Qcap / Qdesign : 1;
      const ss = steadyState[seg.id];
      const iceAdj = iceAdjustments.adjustments.find(a => a.segmentId === seg.id);
      
      return {
        ...seg,
        siltationDepth: sd,
        iceThickness: iceAdj ? iceAdj.iceThickness : 0,
        iceStatus: iceAdj ? iceAdj.status : 'normal',
        manningMultiplier: iceAdj ? iceAdj.manningMultiplier : 1.0,
        effectiveCrossSectionRatio: iceAdj ? iceAdj.effectiveCrossSectionRatio : 1.0,
        effectiveBottomElevation: seg.bottom_elevation + sd,
        constructionStatus: underConstructionIds.includes(seg.id) ? '施工中' : '正常运行',
        capacityRatio: Math.round(capacityRatio * 10000) / 10000,
        designFlow: Math.round(Qdesign * 1000) / 1000,
        capacityFlow: Math.round(Qcap * 1000) / 1000,
        currentFlow: ss ? Math.round(ss.flow * 1000) / 1000 : 0,
        currentUpstreamLevel: segLevels.upstream,
        currentDownstreamLevel: segLevels.downstream,
        safetyLow: safetyLow,
        safetyHigh: safetyHigh
      };
    });
    
    const gatesWithStatus = gates.map(gate => {
      const gatePoints = points.filter(p => p.gate_id === gate.id);
      const upPoint = gatePoints.find(p => p.type === 'upstream_gate');
      const downPoint = gatePoints.find(p => p.type === 'downstream_gate');
      
      const hUp = upPoint ? stateManager.getCurrentWaterLevel(upPoint.id) : null;
      const hDown = downPoint ? stateManager.getCurrentWaterLevel(downPoint.id) : null;
      
      const seg = segments.find(s => s.id === gate.canal_segment_id);
      const ss = seg ? steadyState[seg.id] : null;
      let discharge = ss ? ss.flow : 0;

      if (gate.type === 'diversion' && ss) {
        discharge = ss.diversionFlow;
      }
      
      return {
        ...gate,
        currentUpstreamLevel: hUp,
        currentDownstreamLevel: hDown,
        currentDischarge: Math.round(discharge * 1000) / 1000
      };
    });
    
    const pointsWithStatus = points.map(p => ({
      ...p,
      currentWaterLevel: stateManager.getCurrentWaterLevel(p.id)
    }));
    
    res.json({
      timestamp: Date.now(),
      segments: segmentsWithStatus,
      gates: gatesWithStatus,
      nodes: nodes,
      measurementPoints: pointsWithStatus,
      totalLength: segments.reduce((sum, s) => sum + s.length, 0),
      totalGates: gates.length,
      totalMeasurementPoints: points.length
    });
  } catch (err) {
    console.error('Get topology error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
