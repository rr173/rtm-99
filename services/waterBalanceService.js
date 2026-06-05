const { prepare, saveDatabase } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');
const siltationService = require('./siltationService');

function trapezoidalIntegral(timeSeries) {
  if (!timeSeries || timeSeries.length < 2) {
    return 0;
  }
  
  let total = 0;
  for (let i = 1; i < timeSeries.length; i++) {
    const prev = timeSeries[i - 1];
    const curr = timeSeries[i];
    const dtSeconds = (curr.timestamp - prev.timestamp) / 1000;
    if (dtSeconds > 0) {
      const avgFlow = (prev.flow + curr.flow) / 2;
      total += avgFlow * dtSeconds;
    }
  }
  return total;
}

function calculateEffectiveCrossSection(seg, avgWaterDepth) {
  const siltationDepth = seg.siltation_depth || 0;
  const effectiveDepth = Math.max(0, avgWaterDepth - siltationDepth);
  
  if (effectiveDepth <= 0) {
    return 0;
  }
  
  return hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, effectiveDepth);
}

function getWaterLevelHistory(pointId, startTime, endTime) {
  const history = prepare(`
    SELECT water_level, timestamp 
    FROM water_level_history 
    WHERE point_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(pointId, startTime, endTime);
  
  return history.map(h => ({
    waterLevel: h.water_level,
    timestamp: h.timestamp
  }));
}

function getAllWaterLevelsInWindow(startTime, endTime) {
  const history = prepare(`
    SELECT point_id, water_level, timestamp 
    FROM water_level_history 
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startTime, endTime);
  
  return history.map(h => ({
    pointId: h.point_id,
    waterLevel: h.water_level,
    timestamp: h.timestamp
  }));
}

function getSegmentUpstreamDownstreamPoints(seg) {
  const points = prepare(`
    SELECT * FROM measurement_points 
    WHERE canal_segment_id = ?
    ORDER BY distance_from_upstream
  `).all(seg.id);
  
  if (points.length === 0) {
    return { upstream: null, downstream: null };
  }
  
  return {
    upstream: points[0],
    downstream: points[points.length - 1]
  };
}

function computeFlowFromWaterLevels(seg, upstreamLevel, downstreamLevel, gates) {
  const sd = seg.siltation_depth || 0;
  const upDepth = Math.max(0, upstreamLevel - seg.bottom_elevation);
  const downDepth = Math.max(0, downstreamLevel - seg.bottom_elevation);
  const effUpDepth = Math.max(0, upDepth - sd);
  const effDownDepth = Math.max(0, downDepth - sd);
  
  if (effUpDepth <= 0 || effDownDepth <= 0) {
    return { throughFlow: 0, diversionFlow: 0, totalFlow: 0 };
  }
  
  const avgEffDepth = (effUpDepth + effDownDepth) / 2;
  const A = hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, avgEffDepth);
  const R = hydraulicEngine.trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, avgEffDepth);
  const Q = hydraulicEngine.manningDischarge(seg.manning_n, A, R, seg.bed_slope);
  
  const segGates = gates.filter(g => g.canal_segment_id === seg.id && g.type === 'diversion');
  let divFlow = 0;
  for (const divGate of segGates) {
    if (divGate.current_opening > 0) {
      const Cd = divGate.discharge_coeff;
      const b = divGate.gate_width;
      const e = divGate.current_opening;
      const headDiff = (upstreamLevel - downstreamLevel) * 0.3;
      if (headDiff > 0.01) {
        divFlow += Cd * b * e * Math.sqrt(2 * 9.81 * Math.max(0, headDiff));
      }
    }
  }
  
  return {
    throughFlow: Math.max(0, Q - divFlow),
    diversionFlow: divFlow,
    totalFlow: Q
  };
}

function calculateGateDischargeAtTime(gate, upstreamDepth, downstreamDepth) {
  const Cd = gate.discharge_coeff;
  const b = gate.gate_width;
  const e = gate.current_opening;
  
  if (e <= 0.001 || upstreamDepth <= 0.01) {
    return 0;
  }
  
  const H_up = upstreamDepth;
  const H_down = Math.max(0, downstreamDepth || 0);
  
  if (H_up <= e * 1.05) {
    return 0;
  }
  
  let Q;
  if (H_down <= e * 0.7) {
    Q = Cd * b * e * Math.sqrt(2 * 9.81 * (H_up - e));
  } else {
    const diffHead = H_up - H_down;
    if (diffHead <= 0.001) return 0;
    Q = Cd * b * e * Math.sqrt(2 * 9.81 * diffHead);
  }
  
  return Math.max(0, Q);
}

function getSegmentThresholds(segmentId) {
  const thresholds = prepare(`
    SELECT warning_threshold, alarm_threshold 
    FROM water_balance_thresholds 
    WHERE segment_id = ?
  `).get(segmentId);
  
  if (thresholds) {
    return {
      warning: thresholds.warning_threshold,
      alarm: thresholds.alarm_threshold
    };
  }
  
  return { warning: 5, alarm: 15 };
}

function determineStatus(imbalanceRate, thresholds) {
  const absRate = Math.abs(imbalanceRate);
  if (absRate < thresholds.warning) return 'normal';
  if (absRate < thresholds.alarm) return 'warning';
  return 'alarm';
}

function calculateWaterBalance(windowMinutes = 30) {
  const windowMs = Math.max(10, Math.min(360, windowMinutes)) * 60 * 1000;
  const now = Date.now();
  const windowStart = now - windowMs;
  
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();
  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  
  const orderedSegments = [...segments].sort((a, b) => a.order_index - b.order_index);
  
  const segmentFlowData = {};
  
  for (const seg of orderedSegments) {
    if (underConstructionIds.includes(seg.id)) {
      segmentFlowData[seg.id] = { excluded: true };
      continue;
    }
    
    const { upstream, downstream } = getSegmentUpstreamDownstreamPoints(seg);
    
    if (!upstream || !downstream) {
      segmentFlowData[seg.id] = { excluded: true, reason: 'no_points' };
      continue;
    }
    
    const upHistory = getWaterLevelHistory(upstream.id, windowStart, now);
    const downHistory = getWaterLevelHistory(downstream.id, windowStart, now);
    
    if (upHistory.length < 2 || downHistory.length < 2) {
      const steadyState = getSteadyStateFlows();
      const ss = steadyState[seg.id] || { throughFlow: 0, diversionFlow: 0 };
      const avgFlow = ss.throughFlow || 0;
      const avgDiv = ss.diversionFlow || 0;
      
      const startTime = upHistory.length > 0 ? upHistory[0].timestamp : windowStart;
      const endTime = upHistory.length > 0 ? upHistory[upHistory.length - 1].timestamp : now;
      
      const dt = (endTime - startTime) / 1000;
      segmentFlowData[seg.id] = {
        inflowVolume: avgFlow * dt,
        outflowVolume: avgFlow * dt + avgDiv * dt,
        storageChange: 0,
        startUpLevel: upHistory.length > 0 ? upHistory[0].waterLevel : null,
        endUpLevel: upHistory.length > 0 ? upHistory[upHistory.length - 1].waterLevel : null,
        startDownLevel: downHistory.length > 0 ? downHistory[0].waterLevel : null,
        endDownLevel: downHistory.length > 0 ? downHistory[downHistory.length - 1].waterLevel : null
      };
      continue;
    }
    
    const flowTimeSeries = [];
    const minLen = Math.min(upHistory.length, downHistory.length);
    
    for (let i = 0; i < minLen; i++) {
      const upLv = upHistory[i].waterLevel;
      const downLv = downHistory[i].waterLevel;
      const ts = upHistory[i].timestamp;
      
      const flows = computeFlowFromWaterLevels(seg, upLv, downLv, gates);
      
      const segGates = gates.filter(g => g.canal_segment_id === seg.id && g.type === 'diversion');
      let actualDivFlow = 0;
      for (const divGate of segGates) {
        const gateUpDepth = Math.max(0, upLv - seg.bottom_elevation);
        const gateDownDepth = Math.max(0, downLv - seg.bottom_elevation);
        actualDivFlow += calculateGateDischargeAtTime(divGate, gateUpDepth, gateDownDepth);
      }
      
      flowTimeSeries.push({
        timestamp: ts,
        flow: flows.throughFlow,
        diversion: actualDivFlow
      });
    }
    
    const inflowSeries = flowTimeSeries.map(ft => ({ timestamp: ft.timestamp, flow: ft.flow + ft.diversion }));
    const outflowSeries = flowTimeSeries.map(ft => ({ timestamp: ft.timestamp, flow: ft.flow }));
    
    const inflowVolume = trapezoidalIntegral(inflowSeries);
    const outflowVolume = trapezoidalIntegral(outflowSeries);
    
    const startUpLevel = upHistory[0].waterLevel;
    const endUpLevel = upHistory[upHistory.length - 1].waterLevel;
    const startDownLevel = downHistory[0].waterLevel;
    const endDownLevel = downHistory[downHistory.length - 1].waterLevel;
    
    const startAvgLevel = (startUpLevel + startDownLevel) / 2;
    const endAvgLevel = (endUpLevel + endDownLevel) / 2;
    const startAvgDepth = Math.max(0, startAvgLevel - seg.bottom_elevation);
    const endAvgDepth = Math.max(0, endAvgLevel - seg.bottom_elevation);
    const avgDepth = (startAvgDepth + endAvgDepth) / 2;
    
    const effectiveArea = calculateEffectiveCrossSection(seg, avgDepth);
    const levelChange = endAvgLevel - startAvgLevel;
    const storageChange = effectiveArea * seg.length * levelChange;
    
    segmentFlowData[seg.id] = {
      inflowVolume,
      outflowVolume,
      storageChange,
      startUpLevel,
      endUpLevel,
      startDownLevel,
      endDownLevel
    };
  }
  
  const results = [];
  
  for (let i = 0; i < orderedSegments.length; i++) {
    const seg = orderedSegments[i];
    
    if (segmentFlowData[seg.id]?.excluded) {
      continue;
    }
    
    let actualInflowVolume;
    if (i === 0) {
      actualInflowVolume = segmentFlowData[seg.id].inflowVolume;
    } else {
      const prevSeg = orderedSegments[i - 1];
      actualInflowVolume = segmentFlowData[prevSeg.id]?.outflowVolume || segmentFlowData[seg.id].inflowVolume;
    }
    
    const outflowVolume = segmentFlowData[seg.id].outflowVolume;
    const storageChange = segmentFlowData[seg.id].storageChange;
    
    const imbalanceVolume = actualInflowVolume - outflowVolume - storageChange;
    const imbalanceRate = actualInflowVolume > 0 ? (imbalanceVolume / actualInflowVolume) * 100 : 0;
    
    const thresholds = getSegmentThresholds(seg.id);
    const status = determineStatus(imbalanceRate, thresholds);
    
    const result = {
      segmentId: seg.id,
      segmentName: seg.name,
      windowMinutes: Math.max(10, Math.min(360, windowMinutes)),
      inflowVolume: Math.round(actualInflowVolume * 1000) / 1000,
      outflowVolume: Math.round(outflowVolume * 1000) / 1000,
      storageChange: Math.round(storageChange * 1000) / 1000,
      imbalanceVolume: Math.round(imbalanceVolume * 1000) / 1000,
      imbalanceRate: Math.round(imbalanceRate * 100) / 100,
      status: status,
      warningThreshold: thresholds.warning,
      alarmThreshold: thresholds.alarm,
      calculationTime: now,
      startUpLevel: segmentFlowData[seg.id].startUpLevel,
      endUpLevel: segmentFlowData[seg.id].endUpLevel,
      startDownLevel: segmentFlowData[seg.id].startDownLevel,
      endDownLevel: segmentFlowData[seg.id].endDownLevel
    };
    
    results.push(result);
    
    prepare(`
      INSERT INTO water_balance_records 
      (calculation_time, segment_id, segment_name, window_minutes, 
       inflow_volume, outflow_volume, storage_change, imbalance_volume, 
       imbalance_rate, status, warning_threshold, alarm_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now, seg.id, seg.name, Math.max(10, Math.min(360, windowMinutes)),
      result.inflowVolume, result.outflowVolume, result.storageChange, result.imbalanceVolume,
      result.imbalanceRate, status, thresholds.warning, thresholds.alarm
    );
  }
  
  saveDatabase();
  
  return {
    calculationTime: now,
    windowMinutes: Math.max(10, Math.min(360, windowMinutes)),
    segments: results
  };
}

function getSteadyStateFlows() {
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

  const firstGate = gates.find(g => g.position_on_segment <= 0.01 && g.canal_segment_id === segments[0]?.id);
  let headwaterDepth = 2.5;
  if (firstGate) {
    const gatePoints = points.filter(p => p.gate_id === firstGate.id && p.type === 'upstream_gate');
    if (gatePoints.length > 0) {
      const hwLevel = prepare(`
        SELECT water_level FROM water_level_history 
        WHERE point_id = ? ORDER BY timestamp DESC LIMIT 1
      `).get(gatePoints[0].id);
      if (hwLevel) {
        headwaterDepth = hwLevel.water_level - segments[0].bottom_elevation;
      }
    }
  }

  return hydraulicEngine.computeSteadyState(segmentsForHydraulics, gates, headwaterDepth);
}

function calculateLeakageConfidence(records) {
  if (!records || records.length === 0) {
    return 0;
  }
  
  const avgImbalanceRate = records.reduce((sum, r) => sum + r.imbalance_rate, 0) / records.length;
  const variance = records.reduce((sum, r) => sum + Math.pow(r.imbalance_rate - avgImbalanceRate, 2), 0) / records.length;
  const stdDev = Math.sqrt(variance);
  
  let consecutiveCount = 0;
  const sortedRecords = [...records].sort((a, b) => b.calculation_time - a.calculation_time);
  for (const record of sortedRecords) {
    if (record.status === 'warning' || record.status === 'alarm') {
      consecutiveCount++;
    } else {
      break;
    }
  }
  
  const consecutiveScore = Math.max(0, 50 - (6 - consecutiveCount) * 8);
  
  let rateScore = 0;
  if (avgImbalanceRate > 15) {
    rateScore = 30;
  } else if (avgImbalanceRate >= 10) {
    rateScore = 15 + (avgImbalanceRate - 10) * 3;
  } else if (avgImbalanceRate >= 5) {
    rateScore = (avgImbalanceRate - 5) * 3;
  }
  
  let stabilityScore = 0;
  if (stdDev < 2) {
    stabilityScore = 20;
  } else if (stdDev <= 5) {
    stabilityScore = 10 + (5 - stdDev) * (10 / 3);
  } else if (stdDev <= 10) {
    stabilityScore = (10 - stdDev) * 2;
  }
  
  const totalScore = consecutiveScore + rateScore + Math.max(0, stabilityScore);
  return Math.min(100, Math.max(0, Math.round(totalScore)));
}

function getLeakageAnalysis() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  
  const results = [];
  
  for (const seg of segments) {
    if (underConstructionIds.includes(seg.id)) {
      continue;
    }
    
    const records = prepare(`
      SELECT * FROM water_balance_records 
      WHERE segment_id = ?
      ORDER BY calculation_time DESC
      LIMIT 6
    `).all(seg.id);
    
    if (records.length === 0) {
      continue;
    }
    
    const avgImbalanceRate = records.reduce((sum, r) => sum + r.imbalance_rate, 0) / records.length;
    const variance = records.reduce((sum, r) => sum + Math.pow(r.imbalance_rate - avgImbalanceRate, 2), 0) / records.length;
    const stdDev = Math.sqrt(variance);
    
    let consecutiveCount = 0;
    for (const record of records) {
      if (record.status === 'warning' || record.status === 'alarm') {
        consecutiveCount++;
      } else {
        break;
      }
    }
    
    const confidenceScore = calculateLeakageConfidence(records);
    
    let recommendation = '暂不处理';
    if (confidenceScore > 70) {
      recommendation = '建议立即现场核查';
    } else if (confidenceScore >= 40) {
      recommendation = '建议加密监测';
    }
    
    results.push({
      segmentId: seg.id,
      segmentName: seg.name,
      totalRecords: records.length,
      avgImbalanceRate: Math.round(avgImbalanceRate * 100) / 100,
      stdDevImbalanceRate: Math.round(stdDev * 100) / 100,
      consecutiveExceedCount: consecutiveCount,
      confidenceScore: confidenceScore,
      recommendation: recommendation,
      lastCalculationTime: records[0].calculation_time
    });
  }
  
  results.sort((a, b) => b.confidenceScore - a.confidenceScore);
  
  if (results.length > 0) {
    results[0].isTopCandidate = true;
    results[0].label = '最可能漏损位置';
  }
  
  return {
    analysisTime: Date.now(),
    totalSegments: results.length,
    results: results
  };
}

function getSegmentHistory(segmentId, days = 7) {
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) {
    return { error: '渠段不存在' };
  }
  
  const records = prepare(`
    SELECT * FROM water_balance_records 
    WHERE segment_id = ? AND calculation_time >= ?
    ORDER BY calculation_time DESC
  `).all(segmentId, startTime);
  
  return {
    segmentId: seg.id,
    segmentName: seg.name,
    days: days,
    totalRecords: records.length,
    records: records.map(r => ({
      calculationTime: r.calculation_time,
      windowMinutes: r.window_minutes,
      inflowVolume: r.inflow_volume,
      outflowVolume: r.outflow_volume,
      storageChange: r.storage_change,
      imbalanceVolume: r.imbalance_volume,
      imbalanceRate: r.imbalance_rate,
      status: r.status
    }))
  };
}

function getDailyReport() {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startTime = startOfDay.getTime();
  
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  
  const segmentReports = [];
  let totalInflow = 0;
  let totalLeakage = 0;
  
  for (const seg of segments) {
    if (underConstructionIds.includes(seg.id)) {
      continue;
    }
    
    const records = prepare(`
      SELECT * FROM water_balance_records 
      WHERE segment_id = ? AND calculation_time >= ?
      ORDER BY calculation_time ASC
    `).all(seg.id, startTime);
    
    if (records.length === 0) {
      continue;
    }
    
    const avgImbalanceRate = records.reduce((sum, r) => sum + r.imbalance_rate, 0) / records.length;
    
    let cumulativeLeakage = 0;
    for (let i = 0; i < records.length; i++) {
      if (records[i].imbalance_volume > 0) {
        const timeSpanHours = i < records.length - 1 
          ? (records[i + 1].calculation_time - records[i].calculation_time) / (1000 * 3600)
          : (now - records[i].calculation_time) / (1000 * 3600);
        cumulativeLeakage += records[i].imbalance_volume * timeSpanHours;
      }
    }
    
    const segTotalInflow = records.reduce((sum, r) => sum + r.inflow_volume, 0);
    totalInflow += segTotalInflow;
    totalLeakage += Math.max(0, cumulativeLeakage);
    
    segmentReports.push({
      segmentId: seg.id,
      segmentName: seg.name,
      avgImbalanceRate: Math.round(avgImbalanceRate * 100) / 100,
      estimatedLeakage: Math.round(cumulativeLeakage * 1000) / 1000,
      totalInflow: Math.round(segTotalInflow * 1000) / 1000,
      recordsCount: records.length
    });
  }
  
  const leakageRate = totalInflow > 0 ? (totalLeakage / totalInflow) * 100 : 0;
  
  return {
    reportDate: startOfDay.toISOString().split('T')[0],
    generationTime: now,
    totalSegments: segmentReports.length,
    totalInflowVolume: Math.round(totalInflow * 1000) / 1000,
    totalLeakageVolume: Math.round(totalLeakage * 1000) / 1000,
    overallLeakageRate: Math.round(leakageRate * 100) / 100,
    segments: segmentReports
  };
}

function setSegmentThreshold(segmentId, warningThreshold, alarmThreshold) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) {
    return { error: '渠段不存在' };
  }
  
  if (typeof warningThreshold !== 'number' || warningThreshold <= 0) {
    return { error: 'warningThreshold 必须是正数' };
  }
  if (typeof alarmThreshold !== 'number' || alarmThreshold <= warningThreshold) {
    return { error: 'alarmThreshold 必须大于 warningThreshold' };
  }
  
  const now = Date.now();
  
  const existing = prepare(`
    SELECT id FROM water_balance_thresholds WHERE segment_id = ?
  `).get(segmentId);
  
  if (existing) {
    prepare(`
      UPDATE water_balance_thresholds 
      SET warning_threshold = ?, alarm_threshold = ?, updated_at = ?
      WHERE segment_id = ?
    `).run(warningThreshold, alarmThreshold, now, segmentId);
  } else {
    prepare(`
      INSERT INTO water_balance_thresholds 
      (segment_id, warning_threshold, alarm_threshold, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(segmentId, warningThreshold, alarmThreshold, now);
  }
  
  saveDatabase();
  
  return {
    success: true,
    segmentId: segmentId,
    segmentName: seg.name,
    warningThreshold: warningThreshold,
    alarmThreshold: alarmThreshold,
    updatedAt: now
  };
}

function getAllThresholds() {
  const thresholds = prepare(`
    SELECT segment_id, warning_threshold, alarm_threshold, updated_at 
    FROM water_balance_thresholds
  `).all();
  
  return thresholds.map(t => ({
    segmentId: t.segment_id,
    warningThreshold: t.warning_threshold,
    alarmThreshold: t.alarm_threshold,
    updatedAt: t.updated_at
  }));
}

module.exports = {
  calculateWaterBalance,
  getLeakageAnalysis,
  getSegmentHistory,
  getDailyReport,
  setSegmentThreshold,
  getAllThresholds,
  trapezoidalIntegral
};
