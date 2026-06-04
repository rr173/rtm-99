const { prepare } = require('../db');
const stateManager = require('./stateManager');
const hydraulicEngine = require('./hydraulicEngine');
const siltationService = require('./siltationService');

function detectConflicts() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates ORDER BY canal_segment_id, position_on_segment').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;
  
  const conflicts = [];
  
  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();

  for (const seg of segments) {
    const sd = seg.siltation_depth || 0;
    if (sd <= 0.01) continue;

    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    const gateUpPoints = segPoints.filter(p => p.type === 'upstream_gate' || p.distance_from_upstream <= 0.01);
    
    for (const pt of gateUpPoints) {
      const wl = stateManager.getCurrentWaterLevel(pt.id);
      if (wl === null) continue;
      
      const designLevel = seg.bottom_elevation + seg.design_water_level;
      const normalUpstreamLevel = seg.bottom_elevation + seg.design_water_level * 0.7;
      
      if (wl > normalUpstreamLevel + 0.1) {
        const siltationRatio = sd / seg.design_water_level;
        let severity = 'MEDIUM';
        if (siltationRatio > 0.3) severity = 'HIGH';
        else if (siltationRatio > 0.15) severity = 'MEDIUM';

        conflicts.push({
          id: `conflict_siltation_backwater_${seg.id}_${pt.id}`,
          type: 'SILTATION_BACKWATER',
          severity: severity,
          description: `检测到淤积壅水: ${seg.name} 淤积${(sd * 100).toFixed(1)}cm导致闸前水位异常升高`,
          details: {
            segmentName: seg.name,
            segmentId: seg.id,
            siltationDepth: sd,
            siltationRatio: Math.round(siltationRatio * 10000) / 10000,
            currentWaterLevel: wl,
            normalUpstreamLevel: normalUpstreamLevel,
            excessLevel: wl - normalUpstreamLevel,
            designLevel: designLevel,
            underConstruction: underConstructionIds.includes(seg.id)
          },
          suggestion: {
            action: sd > 0.1 ? '建议安排清淤作业以恢复过流能力' : '建议持续监测淤积发展',
            needsDredging: sd > 0.1
          }
        });
      }
    }
  }
  
  const regulatorGates = gates.filter(g => g.type === 'regulator');
  for (let i = 0; i < regulatorGates.length - 1; i++) {
    const upstreamGate = regulatorGates[i];
    const downstreamGate = regulatorGates[i + 1];
    
    const upstreamSeg = segments.find(s => s.id === upstreamGate.canal_segment_id);
    const downstreamSeg = segments.find(s => s.id === downstreamGate.canal_segment_id);
    
    const upGateUpPoint = points.find(p => p.gate_id === upstreamGate.id && p.type === 'upstream_gate');
    const downGateUpPoint = points.find(p => p.gate_id === downstreamGate.id && p.type === 'upstream_gate');
    
    if (!upGateUpPoint || !downGateUpPoint) continue;
    
    const upWl = stateManager.getCurrentWaterLevel(upGateUpPoint.id);
    const downWl = stateManager.getCurrentWaterLevel(downGateUpPoint.id);
    
    if (upWl === null || downWl === null) continue;
    
    let totalLength = 0;
    let totalDrop = 0;
    const startSeg = segments.findIndex(s => s.id === upstreamSeg.id);
    const endSeg = segments.findIndex(s => s.id === downstreamSeg.id);
    
    for (let j = startSeg; j <= endSeg; j++) {
      totalLength += segments[j].length;
      totalDrop += segments[j].bed_slope * segments[j].length;
    }
    
    const normalDrop = totalDrop;
    const actualDrop = upWl - downWl;
    
    if (actualDrop > normalDrop * 2) {
      const suggestedUpOpening = Math.min(upstreamGate.max_opening, upstreamGate.current_opening * 1.05);
      const suggestedDownOpening = Math.max(0, downstreamGate.current_opening * 0.95);
      
      conflicts.push({
        id: `conflict_robbery_${upstreamGate.id}_${downstreamGate.id}`,
        type: 'ROBBERY',
        severity: 'HIGH',
        description: `检测到下游抢水冲突: ${downstreamGate.name} 可能开度过大，与 ${upstreamGate.name} 水位差异常`,
        details: {
          upstreamGate: upstreamGate.name,
          downstreamGate: downstreamGate.name,
          upstreamWaterLevel: upWl,
          downstreamWaterLevel: downWl,
          actualDrop: actualDrop,
          normalDrop: normalDrop,
          ratio: (actualDrop / normalDrop).toFixed(2)
        },
        suggestion: {
          action: '建议减少下游闸开度或增加上游闸开度',
          upstreamGateAdjustment: {
            gateId: upstreamGate.id,
            gateName: upstreamGate.name,
            currentOpening: upstreamGate.current_opening,
            suggestedOpening: Math.round(suggestedUpOpening * 1000) / 1000,
            adjustmentPercent: +5
          },
          downstreamGateAdjustment: {
            gateId: downstreamGate.id,
            gateName: downstreamGate.name,
            currentOpening: downstreamGate.current_opening,
            suggestedOpening: Math.round(suggestedDownOpening * 1000) / 1000,
            adjustmentPercent: -5
          }
        }
      });
    }
  }
  
  for (const gate of gates) {
    if (gate.position_on_segment > 0) continue;
    
    const seg = segments.find(s => s.id === gate.canal_segment_id);
    const gateUpPoints = points.filter(p => p.gate_id === gate.id);
    const gateUpPoint = gateUpPoints.find(p => p.type === 'upstream_gate') || 
                        points.find(p => p.canal_segment_id === gate.canal_segment_id && p.distance_from_upstream <= 0.01);
    const gateDownPoint = gateUpPoints.find(p => p.type === 'downstream_gate');
    
    if (!gateUpPoint) continue;
    
    const history = prepare(`
      SELECT water_level, timestamp FROM water_level_history
      WHERE point_id = ? AND timestamp >= ?
      ORDER BY timestamp
    `).all(gateUpPoint.id, tenMinutesAgo);
    
    if (history.length < 10) continue;
    
    const firstLevel = history[0].water_level;
    const lastLevel = history[history.length - 1].water_level;
    const riseAmount = lastLevel - firstLevel;
    
    let downStable = true;
    if (gateDownPoint) {
      const downHistory = prepare(`
        SELECT water_level FROM water_level_history
        WHERE point_id = ? AND timestamp >= ?
        ORDER BY timestamp
      `).all(gateDownPoint.id, tenMinutesAgo);
      
      if (downHistory.length >= 10) {
        const downVariance = downHistory.reduce((sum, h, i, arr) => {
          if (i === 0) return 0;
          return sum + Math.abs(h.water_level - arr[i - 1].water_level);
        }, 0);
        downStable = downVariance < 0.05;
      }
    }
    
    if (riseAmount > 0.15 && downStable) {
      const nextRegIndex = segments.findIndex(s => s.id === seg.id) + 1;
      let nextGate = null;
      let nextSeg = null;
      if (nextRegIndex < segments.length) {
        nextSeg = segments[nextRegIndex];
        nextGate = gates.find(g => g.type === 'regulator' && g.canal_segment_id === nextSeg.id && g.position_on_segment <= 0.01);
      }
      
      const isSiltationRelated = nextSeg && (nextSeg.siltation_depth || 0) > 0.05;
      
      if (!isSiltationRelated) {
        conflicts.push({
          id: `conflict_backwater_${gate.id}`,
          type: 'BACKWATER',
          severity: 'MEDIUM',
          description: `检测到下游壅水冲突: ${gate.name} 闸前水位持续上涨，可能下游阻水`,
          details: {
            gateName: gate.name,
            waterLevelRise: riseAmount,
            timePeriodMinutes: 10,
            downstreamStable: downStable,
            currentUpstreamLevel: lastLevel,
            designLevel: seg.bottom_elevation + seg.design_water_level
          },
          suggestion: nextGate ? {
            action: '建议增加下游闸开度以泄水',
            targetGate: {
              gateId: nextGate.id,
              gateName: nextGate.name,
              currentOpening: nextGate.current_opening,
              suggestedOpening: Math.round(Math.min(nextGate.max_opening, nextGate.current_opening * 1.05) * 1000) / 1000,
              adjustmentPercent: +5
            }
          } : {
            action: '建议检查下游渠道是否有堵塞',
            note: '渠尾无节制闸，无法通过调度解决'
          }
        });
      }
    }
  }
  
  for (const seg of segments) {
    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    const safetyLow = seg.bottom_elevation + 0.3;
    const safetyHigh = seg.bottom_elevation + seg.design_water_level * 0.9;
    
    for (const point of segPoints) {
      const wl = stateManager.getCurrentWaterLevel(point.id);
      if (wl === null) continue;
      
      if (wl < safetyLow) {
        conflicts.push({
          id: `conflict_low_${point.id}`,
          type: 'SAFETY_LOW',
          severity: 'HIGH',
          description: `水位越限告警: ${point.name} 水位低于安全下限`,
          details: {
            pointName: point.name,
            currentLevel: wl,
            safetyLow: safetyLow,
            deficit: safetyLow - wl
          },
          suggestion: {
            action: '建议增加上游闸开度',
            note: '需要增加入流量以提升水位'
          }
        });
      } else if (wl > safetyHigh) {
        conflicts.push({
          id: `conflict_high_${point.id}`,
          type: 'SAFETY_HIGH',
          severity: 'HIGH',
          description: `水位越限告警: ${point.name} 水位高于安全上限`,
          details: {
            pointName: point.name,
            currentLevel: wl,
            safetyHigh: safetyHigh,
            excess: wl - safetyHigh
          },
          suggestion: {
            action: '建议减少上游闸开度或增加下游泄水',
            note: '需要减少入流量或增加出流量以降低水位'
          }
        });
      }
    }
  }
  
  return {
    timestamp: now,
    totalConflicts: conflicts.length,
    conflicts: conflicts
  };
}

function calculateGateDischarge(gate) {
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
  const seg = segments.find(s => s.id === gate.canal_segment_id);
  const ss = seg ? steadyState[seg.id] : null;

  if (!ss) return 0;
  if (gate.type === 'diversion') return ss.diversionFlow;
  return ss.flow;
}

function getSystemSummary() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  
  let totalInflow = 0;
  let totalDiversion = 0;
  
  const firstReg = gates.find(g => g.type === 'regulator' && g.position_on_segment <= 0.01);
  if (firstReg) {
    totalInflow = calculateGateDischarge(firstReg);
  }
  
  for (const gate of gates) {
    if (gate.type === 'diversion') {
      totalDiversion += calculateGateDischarge(gate);
    }
  }
  
  const segmentAverages = [];
  let exceedingCount = 0;
  
  for (const seg of segments) {
    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    const levels = segPoints.map(p => stateManager.getCurrentWaterLevel(p.id)).filter(l => l !== null);
    const avg = levels.length > 0 ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
    
    const safetyLow = seg.bottom_elevation + 0.3;
    const safetyHigh = seg.bottom_elevation + seg.design_water_level * 0.9;
    
    for (const l of levels) {
      if (l < safetyLow || l > safetyHigh) exceedingCount++;
    }
    
    segmentAverages.push({
      segmentId: seg.id,
      segmentName: seg.name,
      averageWaterLevel: avg,
      safetyLow: safetyLow,
      safetyHigh: safetyHigh,
      siltationDepth: seg.siltation_depth || 0
    });
  }
  
  const gateStatuses = gates.map(g => ({
    gateId: g.id,
    name: g.name,
    type: g.type,
    currentOpening: g.current_opening,
    discharge: calculateGateDischarge(g)
  }));
  
  return {
    timestamp: Date.now(),
    totalInflow: Math.round(totalInflow * 1000) / 1000,
    totalDiversion: Math.round(totalDiversion * 1000) / 1000,
    netOutflow: Math.round((totalInflow - totalDiversion) * 1000) / 1000,
    segmentAverages: segmentAverages,
    gateStatuses: gateStatuses,
    exceedingPointsCount: exceedingCount,
    totalMeasurementPoints: points.length
  };
}

module.exports = {
  detectConflicts,
  getSystemSummary,
  calculateGateDischarge
};
