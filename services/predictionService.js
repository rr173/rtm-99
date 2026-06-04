const { prepare } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');
const stateManager = require('./stateManager');
const siltationService = require('./siltationService');

const PREDICT_STEPS = 600;

function predictWaterLevels(adjustments) {
  const startTime = Date.now();
  
  const segmentsRaw = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();

  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();

  const segments = segmentsRaw.map(seg => {
    if (underConstructionIds.includes(seg.id)) {
      return { ...seg, siltation_depth: seg.design_water_level, _underConstruction: true };
    }
    return seg;
  });

  const siltationInfo = {};
  for (const seg of segmentsRaw) {
    const isUnderConstruction = underConstructionIds.includes(seg.id);
    if (isUnderConstruction) {
      siltationInfo[seg.id] = {
        siltationDepth: seg.siltation_depth || 0,
        effectiveDepth: 0,
        underConstruction: true
      };
    } else {
      const sd = seg.siltation_depth || 0;
      siltationInfo[seg.id] = {
        siltationDepth: sd,
        effectiveDepth: Math.max(0, seg.design_water_level - sd),
        underConstruction: false
      };
    }
  }
  
  const adjustedGates = {};
  for (const adj of adjustments) {
    const gate = gates.find(g => g.id === adj.gateId);
    if (gate) {
      adjustedGates[adj.gateId] = {
        ...gate,
        current_opening: Math.max(0, Math.min(gate.max_opening, adj.newOpening))
      };
    }
  }
  
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
  
  const steadyStateCurrent = hydraulicEngine.computeSteadyState(segments, gates, headwaterDepth);
  
  const initialConditions = {};
  for (const seg of segments) {
    const ss = steadyStateCurrent[seg.id];
    initialConditions[seg.id] = {
      canalUpstream: ss.canalUpstream,
      canalDownstream: ss.canalDownstream
    };
  }
  
  const simulationResults = hydraulicEngine.runSimulation(
    segments, gates, initialConditions, PREDICT_STEPS, adjustedGates, headwaterDepth
  );
  
  const predictions = {};
  for (const point of points) {
    predictions[point.id] = {
      pointId: point.id,
      pointName: point.name,
      segmentId: point.canal_segment_id,
      timeSeries: []
    };
  }
  
  for (let i = 0; i < simulationResults.length; i++) {
    const snapshot = simulationResults[i];
    const timeMinutes = Math.round(snapshot.timestamp / 60);
    
    for (const point of points) {
      const segGrid = snapshot[point.canal_segment_id];
      if (segGrid) {
        const wl = hydraulicEngine.interpolateWaterLevelAtPoint(
          segGrid, point.distance_from_upstream, 
          segments.find(s => s.id === point.canal_segment_id)
        );
        if (!isNaN(wl) && isFinite(wl)) {
          predictions[point.id].timeSeries.push({
            time: timeMinutes,
            waterLevel: Math.round(wl * 1000) / 1000
          });
        }
      }
    }
  }
  
  for (const pointId in predictions) {
    const pred = predictions[pointId];
    let stableTime = null;
    for (let i = 1; i < pred.timeSeries.length; i++) {
      const rate = Math.abs(pred.timeSeries[i].waterLevel - pred.timeSeries[i - 1].waterLevel);
      if (rate < 0.01) {
        stableTime = pred.timeSeries[i].time;
        break;
      }
    }
    pred.stableTimeMinutes = stableTime;
    
    const point = points.find(p => p.id === pointId);
    const seg = segments.find(s => s.id === point.canal_segment_id);
    const safetyLow = seg.bottom_elevation + 0.3;
    const safetyHigh = seg.bottom_elevation + seg.design_water_level * 0.9;
    
    let hasViolation = false;
    let violationType = null;
    for (const ts of pred.timeSeries) {
      if (ts.waterLevel < safetyLow) {
        hasViolation = true;
        violationType = 'LOW';
        break;
      }
      if (ts.waterLevel > safetyHigh) {
        hasViolation = true;
        violationType = 'HIGH';
        break;
      }
    }
    pred.safetyAlert = hasViolation ? {
      type: violationType,
      safetyLow: safetyLow,
      safetyHigh: safetyHigh,
      minLevel: Math.min(...pred.timeSeries.map(t => t.waterLevel)),
      maxLevel: Math.max(...pred.timeSeries.map(t => t.waterLevel))
    } : null;
  }
  
  const steadyStateAdjusted = hydraulicEngine.computeSteadyState(segments, gates, headwaterDepth, adjustedGates);
  
  const gateDischargePredictions = {};
  for (const gate of gates) {
    const gateToUse = adjustedGates[gate.id] || gate;
    const seg = segments.find(s => s.id === gate.canal_segment_id);
    const segIdx = segments.findIndex(s => s.id === gate.canal_segment_id);
    
    gateDischargePredictions[gate.id] = {
      gateId: gate.id,
      gateName: gate.name,
      type: gate.type,
      initialOpening: gate.current_opening,
      adjustedOpening: gateToUse.current_opening,
      initialDischarge: steadyStateCurrent[seg.id] ? steadyStateCurrent[seg.id].flow : 0,
      timeSeries: []
    };
    
    if (!seg) continue;
    
    const segGrid = simulationResults.length > 0 ? simulationResults[0][seg.id] : null;
    const lastSnapshot = simulationResults.length > 0 ? simulationResults[simulationResults.length - 1][seg.id] : null;
    
    const nSteps = simulationResults.length;
    
    for (let i = 0; i < nSteps; i++) {
      const snapshot = simulationResults[i];
      const segGridSnap = snapshot[seg.id];
      if (!segGridSnap) continue;
      
      let depthUp, depthDown;
      
      if (gate.position_on_segment <= 0.01 && segIdx === 0) {
        depthUp = headwaterDepth;
      } else if (gate.position_on_segment <= 0.01 && segIdx > 0) {
        const prevSeg = segments[segIdx - 1];
        const prevSegGridSnap = snapshot[prevSeg.id];
        if (prevSegGridSnap && prevSegGridSnap.length > 0) {
          const lastNodeAbs = prevSegGridSnap[prevSegGridSnap.length - 1].h;
          depthUp = lastNodeAbs - seg.bottom_elevation;
        } else {
          depthUp = headwaterDepth;
        }
      } else {
        const gateNodeIdx = Math.round(gate.position_on_segment / hydraulicEngine.DX);
        if (gateNodeIdx < segGridSnap.length) {
          depthUp = segGridSnap[gateNodeIdx].h - seg.bottom_elevation;
        } else {
          depthUp = 1.5;
        }
      }
      
      const downNodeIdx = Math.min(segGridSnap.length - 1, Math.round(gate.position_on_segment / hydraulicEngine.DX) + 1);
      if (downNodeIdx < segGridSnap.length) {
        depthDown = segGridSnap[downNodeIdx].h - seg.bottom_elevation;
      } else {
        depthDown = Math.max(0, depthUp - 0.2);
      }
      
      const Q = hydraulicEngine.calculateGateDischarge(gateToUse, depthUp, depthDown);
      
      gateDischargePredictions[gate.id].timeSeries.push({
        time: i,
        discharge: Math.round(Q * 1000) / 1000
      });
    }
  }
  
  const computeTime = Date.now() - startTime;
  
  return {
    computeTimeMs: computeTime,
    totalSteps: PREDICT_STEPS,
    timeHorizonMinutes: Math.round(PREDICT_STEPS * hydraulicEngine.DT / 60),
    headwaterDepth: headwaterDepth,
    siltationInfo: siltationInfo,
    steadyStateCurrent: Object.fromEntries(Object.entries(steadyStateCurrent).map(([k, v]) => [k, {
      flow: Math.round(v.flow * 1000) / 1000,
      normalDepth: Math.round(v.normalDepth * 1000) / 1000,
      effectiveDepth: v.effectiveDepth !== undefined ? Math.round(v.effectiveDepth * 1000) / 1000 : undefined,
      siltationDepth: v.siltationDepth !== undefined ? Math.round(v.siltationDepth * 1000) / 1000 : undefined,
      upstreamLevel: Math.round(v.upstreamLevel * 1000) / 1000,
      downstreamLevel: Math.round(v.downstreamLevel * 1000) / 1000
    }])),
    predictions: predictions,
    gateDischarges: gateDischargePredictions
  };
}

module.exports = {
  predictWaterLevels,
  PREDICT_STEPS
};
