const { prepare, saveDatabase } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');
const siltationService = require('./siltationService');
const stateManager = require('./stateManager');

function trapezoidalIntegral(timeSeries) {
  if (!timeSeries || timeSeries.length < 2) {
    return 0;
  }
  
  let total = 0;
  for (let i = 1; i < timeSeries.length; i++) {
    const prev = timeSeries[i - 1];
    const curr = timeSeries[i];
    const dtHours = (curr.timestamp - prev.timestamp) / (1000 * 3600);
    if (dtHours > 0) {
      const avgFlow = (prev.flow + curr.flow) / 2;
      total += avgFlow * dtHours * 3600;
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

function getSteadyStateWithFlows() {
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
      const hwLevel = stateManager.getCurrentWaterLevel(gatePoints[0].id);
      if (hwLevel !== null) {
        headwaterDepth = hwLevel - segments[0].bottom_elevation;
      }
    }
  }

  return hydraulicEngine.computeSteadyState(segmentsForHydraulics, gates, headwaterDepth);
}

function generateFlowTimeSeries(segId, gate, windowStart, windowEnd, isDiversion = false) {
  const steadyState = getSteadyStateWithFlows();
  const baseFlow = steadyState[segId] ? 
    (isDiversion ? steadyState[segId].diversionFlow : steadyState[segId].flow) : 0;
  
  const timeSeries = [];
  const interval = 5 * 60 * 1000;
  
  for (let t = windowStart; t <= windowEnd; t += interval) {
    const noise = 1 + (Math.random() - 0.5) * 0.1;
    timeSeries.push({
      timestamp: t,
      flow: baseFlow * noise
    });
  }
  
  return timeSeries;
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
  const points = prepare('SELECT * FROM measurement_points').all();
  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  
  const results = [];
  const steadyState = getSteadyStateWithFlows();
  
  for (const seg of segments) {
    if (underConstructionIds.includes(seg.id)) {
      continue;
    }
    
    const segGates = gates.filter(g => g.canal_segment_id === seg.id);
    const upstreamGate = segGates.find(g => g.position_on_segment <= 0.01);
    const downstreamGate = segGates.find(g => g.position_on_segment > 0.99);
    const divGates = segGates.filter(g => g.type === 'diversion' && g.position_on_segment > 0);
    
    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    const upstreamPoint = segPoints.find(p => p.distance_from_upstream <= 1);
    const downstreamPoint = segPoints.find(p => Math.abs(p.distance_from_upstream - seg.length) < 1);
    
    const waterLevelHistory = prepare(`
      SELECT water_level, timestamp 
      FROM water_level_history 
      WHERE point_id IN (?, ?) AND timestamp >= ?
      ORDER BY timestamp ASC
    `).all(upstreamPoint?.id || '', downstreamPoint?.id || '', windowStart);
    
    const upstreamLevels = waterLevelHistory.filter(h => upstreamPoint && h.point_id === upstreamPoint.id);
    const downstreamLevels = waterLevelHistory.filter(h => downstreamPoint && h.point_id === downstreamPoint.id);
    
    let startUpLevel = null, endUpLevel = null;
    let startDownLevel = null, endDownLevel = null;
    
    if (upstreamLevels.length > 0) {
      startUpLevel = upstreamLevels[0].water_level;
      endUpLevel = upstreamLevels[upstreamLevels.length - 1].water_level;
    }
    if (downstreamLevels.length > 0) {
      startDownLevel = downstreamLevels[0].water_level;
      endDownLevel = downstreamLevels[downstreamLevels.length - 1].water_level;
    }
    
    const ss = steadyState[seg.id];
    if (startUpLevel === null && ss) startUpLevel = ss.upstreamLevel;
    if (endUpLevel === null && ss) endUpLevel = ss.upstreamLevel;
    if (startDownLevel === null && ss) startDownLevel = ss.downstreamLevel;
    if (endDownLevel === null && ss) endDownLevel = ss.downstreamLevel;
    
    const inflowSeries = generateFlowTimeSeries(seg.id, upstreamGate, windowStart, now, false);
    const inflowVolume = trapezoidalIntegral(inflowSeries);
    
    const outflowSeries = generateFlowTimeSeries(seg.id, downstreamGate, windowStart, now, false);
    let outflowVolume = trapezoidalIntegral(outflowSeries);
    
    for (const divGate of divGates) {
      const divSeries = generateFlowTimeSeries(seg.id, divGate, windowStart, now, true);
      outflowVolume += trapezoidalIntegral(divSeries);
    }
    
    const startAvgLevel = ((startUpLevel || 0) + (startDownLevel || 0)) / 2;
    const endAvgLevel = ((endUpLevel || 0) + (endDownLevel || 0)) / 2;
    const startAvgDepth = Math.max(0, startAvgLevel - seg.bottom_elevation);
    const endAvgDepth = Math.max(0, endAvgLevel - seg.bottom_elevation);
    const avgDepth = (startAvgDepth + endAvgDepth) / 2;
    
    const effectiveArea = calculateEffectiveCrossSection(seg, avgDepth);
    const levelChange = endAvgLevel - startAvgLevel;
    const storageChange = effectiveArea * seg.length * levelChange;
    
    const imbalanceVolume = inflowVolume - outflowVolume - storageChange;
    const imbalanceRate = inflowVolume > 0 ? (imbalanceVolume / inflowVolume) * 100 : 0;
    
    const thresholds = getSegmentThresholds(seg.id);
    const status = determineStatus(imbalanceRate, thresholds);
    
    const result = {
      segmentId: seg.id,
      segmentName: seg.name,
      windowMinutes: Math.max(10, Math.min(360, windowMinutes)),
      inflowVolume: Math.round(inflowVolume * 1000) / 1000,
      outflowVolume: Math.round(outflowVolume * 1000) / 1000,
      storageChange: Math.round(storageChange * 1000) / 1000,
      imbalanceVolume: Math.round(imbalanceVolume * 1000) / 1000,
      imbalanceRate: Math.round(imbalanceRate * 100) / 100,
      status: status,
      warningThreshold: thresholds.warning,
      alarmThreshold: thresholds.alarm,
      calculationTime: now
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
