const { prepare, saveDatabase } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');
const stateManager = require('./stateManager');
const predictionService = require('./predictionService');
const siltationService = require('./siltationService');

const g = 9.81;
const SAFETY_COEFFICIENT = 1.2;
const MAINTENANCE_FLOW_RATIO = 0.2;

function getTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function resetDailyQuotaIfNeeded(irrigation) {
  const today = getTodayStr();
  if (irrigation.quota_date !== today) {
    irrigation.daily_taken = 0;
    irrigation.quota_date = today;
  }
  return irrigation;
}

function getSecondsRemainingToday() {
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return Math.max(1, (endOfDay.getTime() - now.getTime()) / 1000);
}

function updateIrrigationTaken(irrigationId, addedVolume) {
  const irrig = prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(irrigationId);
  if (!irrig) return;

  const resetIrrig = resetDailyQuotaIfNeeded(irrig);
  const newTaken = Math.max(0, resetIrrig.daily_taken + addedVolume);
  const now = Date.now();

  prepare(`
    UPDATE dispatch_irrigations 
    SET daily_taken = ?, quota_date = ?, updated_at = ?, last_calc_time = ?
    WHERE id = ?
  `).run(newTaken, resetIrrig.quota_date, now, now, irrigationId);
}

function calculateWeirFlow(Cd, b, e, H_up) {
  if (e <= 0.001 || H_up <= e * 1.05) return 0;
  return Cd * b * e * Math.sqrt(2 * g * (H_up - e));
}

function solveGateOpeningForFlow(targetQ, gate, H_up) {
  if (targetQ <= 0) return 0;
  if (H_up <= 0.01) return 0;

  const Cd = gate.discharge_coeff;
  const b = gate.gate_width;
  const maxE = Math.min(gate.max_opening, H_up * 0.95);
  const minE = 0.001;

  const Qmax = calculateWeirFlow(Cd, b, maxE, H_up);
  if (targetQ >= Qmax) return maxE;

  let lo = minE;
  let hi = maxE;

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const Qmid = calculateWeirFlow(Cd, b, mid, H_up);

    if (Math.abs(Qmid - targetQ) < 1e-5) {
      return mid;
    }

    if (Qmid < targetQ) {
      lo = mid;
    } else {
      hi = mid;
    }

    if (hi - lo < 1e-6) break;
  }

  return (lo + hi) / 2;
}

function getGateUpstreamDepth(gate) {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  const gates = prepare('SELECT * FROM gates').all();
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

  if (!ss) return headwaterDepth;
  return ss.canalUpstream || headwaterDepth;
}

function getDesignFlow() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  if (segments.length === 0) return 5;

  const seg1 = segments[0];
  const A = hydraulicEngine.trapezoidalArea(
    seg1.bottom_width, seg1.side_slope, seg1.design_water_level * 0.7
  );
  const R = hydraulicEngine.trapezoidalHydraulicRadius(
    seg1.bottom_width, seg1.side_slope, seg1.design_water_level * 0.7
  );
  return hydraulicEngine.manningDischarge(seg1.manning_n, A, R, seg1.bed_slope) || 5;
}

function getAllIrrigationsWithStatus() {
  const all = prepare('SELECT * FROM dispatch_irrigations ORDER BY priority ASC, id ASC').all();
  return all.map(irrig => {
    const reset = resetDailyQuotaIfNeeded(irrig);
    const remaining = Math.max(0, reset.daily_quota - reset.daily_taken);
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(reset.gate_id);
    return {
      id: reset.id,
      name: reset.name,
      gate_id: reset.gate_id,
      gate_name: gate ? gate.name : null,
      daily_quota: reset.daily_quota,
      priority: reset.priority,
      min_flow: reset.min_flow,
      max_flow: reset.max_flow,
      daily_taken: reset.daily_taken,
      remaining_quota: remaining,
      quota_date: reset.quota_date,
      last_calc_time: reset.last_calc_time,
      created_at: reset.created_at,
      updated_at: reset.updated_at
    };
  });
}

function createIrrigation(data) {
  const now = Date.now();
  const today = getTodayStr();

  const result = prepare(`
    INSERT INTO dispatch_irrigations 
    (name, gate_id, daily_quota, priority, min_flow, max_flow, 
     daily_taken, last_calc_time, quota_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.gate_id,
    parseFloat(data.daily_quota),
    parseInt(data.priority),
    parseFloat(data.min_flow),
    parseFloat(data.max_flow),
    0,
    now,
    today,
    now,
    now
  );

  saveDatabase();

  return prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(result.lastInsertRowid);
}

function updateIrrigation(id, data) {
  const existing = prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(id);
  if (!existing) return null;

  const now = Date.now();

  prepare(`
    UPDATE dispatch_irrigations SET
      name = ?,
      gate_id = ?,
      daily_quota = ?,
      priority = ?,
      min_flow = ?,
      max_flow = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    data.name !== undefined ? data.name : existing.name,
    data.gate_id !== undefined ? data.gate_id : existing.gate_id,
    data.daily_quota !== undefined ? parseFloat(data.daily_quota) : existing.daily_quota,
    data.priority !== undefined ? parseInt(data.priority) : existing.priority,
    data.min_flow !== undefined ? parseFloat(data.min_flow) : existing.min_flow,
    data.max_flow !== undefined ? parseFloat(data.max_flow) : existing.max_flow,
    now,
    id
  );

  saveDatabase();
  return prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(id);
}

function deleteIrrigation(id) {
  const result = prepare('DELETE FROM dispatch_irrigations WHERE id = ?').run(id);
  saveDatabase();
  return result.changes > 0;
}

function accumulateIrrigationsWaterUsage() {
  const irrigations = prepare('SELECT * FROM dispatch_irrigations').all();
  const now = Date.now();
  const gates = prepare('SELECT * FROM gates').all();
  const gateMap = {};
  for (const g of gates) gateMap[g.id] = g;

  for (const irrig of irrigations) {
    if (irrig.last_calc_time && irrig.last_calc_time > 0) {
      const dt = Math.max(0, (now - irrig.last_calc_time) / 1000);
      if (dt > 0 && dt < 3600 * 24) {
        const gate = gateMap[irrig.gate_id];
        if (gate) {
          const H_up = getGateUpstreamDepth(gate);
          const currentQ = calculateWeirFlow(
            gate.discharge_coeff,
            gate.gate_width,
            gate.current_opening,
            H_up
          );
          const volume = currentQ * dt;
          updateIrrigationTaken(irrig.id, volume);
        }
      }
    } else {
      prepare('UPDATE dispatch_irrigations SET last_calc_time = ? WHERE id = ?').run(now, irrig.id);
    }
  }
}

function aggregateGateOpenings(allocations, gateMap) {
  const gateFlowMap = {};
  for (const alloc of allocations) {
    if (!gateFlowMap[alloc.gate_id]) {
      gateFlowMap[alloc.gate_id] = 0;
    }
    gateFlowMap[alloc.gate_id] += alloc.suggested_flow || 0;
  }

  const gateOpeningMap = {};
  for (const gateId in gateFlowMap) {
    const gate = gateMap[gateId];
    if (!gate) continue;
    const totalFlow = gateFlowMap[gateId];
    const H_up = getGateUpstreamDepth(gate);
    const opening = totalFlow > 0
      ? solveGateOpeningForFlow(totalFlow, gate, H_up)
      : 0;
    gateOpeningMap[gateId] = {
      total_flow: Math.round(totalFlow * 10000) / 10000,
      unified_opening: Math.round(opening * 10000) / 10000
    };
  }

  return { gateFlowMap, gateOpeningMap };
}

function optimizeDispatch(inflowRate) {
  accumulateIrrigationsWaterUsage();

  const irrigationsRaw = prepare('SELECT * FROM dispatch_irrigations').all();
  const irrigations = irrigationsRaw.map(i => resetDailyQuotaIfNeeded(i));

  const gates = prepare('SELECT * FROM gates').all();
  const gateMap = {};
  for (const g of gates) gateMap[g.id] = g;

  const designFlow = getDesignFlow();
  const maintenanceFlow = designFlow * MAINTENANCE_FLOW_RATIO;

  const availableWater = Math.max(0, inflowRate - maintenanceFlow);
  const totalMinFlow = irrigations.reduce((s, i) => s + i.min_flow, 0);

  let isWaterRestrictionMode = false;
  let restrictionCutOrder = [];
  if (inflowRate < totalMinFlow + maintenanceFlow) {
    isWaterRestrictionMode = true;
    const sortedDesc = [...irrigations].sort((a, b) => b.priority - a.priority);
    restrictionCutOrder = sortedDesc.map(i => i.id);
  }

  const sortedByPriority = [...irrigations].sort((a, b) => a.priority - b.priority);
  const secondsLeft = getSecondsRemainingToday();

  const allocations = [];
  const underProvisioned = [];
  let totalAllocated = 0;
  let currentAvailable = availableWater;
  let cutoffStarted = false;

  for (const irrig of sortedByPriority) {
    const gate = gateMap[irrig.gate_id];
    if (!gate) continue;

    const remaining = Math.max(0, irrig.daily_quota - irrig.daily_taken);

    if (remaining <= 0) {
      allocations.push({
        irrigation_id: irrig.id,
        irrigation_name: irrig.name,
        gate_id: irrig.gate_id,
        priority: irrig.priority,
        suggested_flow: 0,
        status: 'quota_exhausted',
        remaining_quota: 0,
        min_flow: irrig.min_flow,
        max_flow: irrig.max_flow
      });
      continue;
    }

    if (isWaterRestrictionMode && !cutoffStarted) {
      if (restrictionCutOrder.includes(irrig.id)) {
        const remainingAfter = restrictionCutOrder
          .filter(id => id !== irrig.id)
          .map(id => {
            const it = irrigations.find(x => x.id === id);
            return it ? it.min_flow : 0;
          })
          .reduce((s, v) => s + v, 0);

        if (currentAvailable < irrig.min_flow || currentAvailable - irrig.min_flow < remainingAfter) {
          cutoffStarted = true;
        }
      }
    }

    if (cutoffStarted) {
      underProvisioned.push({
        irrigation_id: irrig.id,
        irrigation_name: irrig.name,
        gate_id: irrig.gate_id,
        priority: irrig.priority,
        reason: isWaterRestrictionMode ? 'water_restriction_cutoff' : 'insufficient_flow'
      });
      allocations.push({
        irrigation_id: irrig.id,
        irrigation_name: irrig.name,
        gate_id: irrig.gate_id,
        priority: irrig.priority,
        suggested_flow: 0,
        status: 'under_provisioned',
        remaining_quota: remaining,
        min_flow: irrig.min_flow,
        max_flow: irrig.max_flow
      });
      continue;
    }

    const quotaBasedFlow = (remaining / secondsLeft) * SAFETY_COEFFICIENT;
    let candidateFlow = Math.min(irrig.max_flow, quotaBasedFlow, currentAvailable);

    if (candidateFlow < irrig.min_flow) {
      underProvisioned.push({
        irrigation_id: irrig.id,
        irrigation_name: irrig.name,
        gate_id: irrig.gate_id,
        priority: irrig.priority,
        reason: 'below_minimum_flow'
      });
      allocations.push({
        irrigation_id: irrig.id,
        irrigation_name: irrig.name,
        gate_id: irrig.gate_id,
        priority: irrig.priority,
        suggested_flow: 0,
        status: 'under_provisioned',
        remaining_quota: remaining,
        min_flow: irrig.min_flow,
        max_flow: irrig.max_flow
      });
      continue;
    }

    const H_up = getGateUpstreamDepth(gate);
    const actualFlow = candidateFlow;

    currentAvailable -= actualFlow;
    totalAllocated += actualFlow;

    allocations.push({
      irrigation_id: irrig.id,
      irrigation_name: irrig.name,
      gate_id: irrig.gate_id,
      priority: irrig.priority,
      suggested_flow: Math.round(actualFlow * 10000) / 10000,
      status: 'allocated',
      remaining_quota: Math.round(remaining * 10000) / 10000,
      min_flow: irrig.min_flow,
      max_flow: irrig.max_flow
    });
  }

  const { gateFlowMap, gateOpeningMap } = aggregateGateOpenings(allocations, gateMap);

  for (const alloc of allocations) {
    const gateInfo = gateOpeningMap[alloc.gate_id];
    if (gateInfo) {
      alloc.gate_total_flow = gateInfo.total_flow;
      alloc.gate_unified_opening = gateInfo.unified_opening;
      alloc.suggested_opening = gateInfo.unified_opening;
    } else {
      alloc.gate_total_flow = 0;
      alloc.gate_unified_opening = 0;
      alloc.suggested_opening = 0;
    }
  }

  const totalInflow = inflowRate;
  const reservedMaintenance = maintenanceFlow;
  const allocationEfficiency = totalInflow > 0
    ? Math.round((totalAllocated / totalInflow) * 10000) / 100
    : 0;

  const waterBalance = {
    total_inflow: Math.round(totalInflow * 10000) / 10000,
    total_allocated: Math.round(totalAllocated * 10000) / 10000,
    maintenance_reserve: Math.round(reservedMaintenance * 10000) / 10000,
    remaining_unallocated: Math.round(Math.max(0, totalInflow - totalAllocated - reservedMaintenance) * 10000) / 10000,
    allocation_efficiency_percent: allocationEfficiency
  };

  const gate_plan = [];
  for (const gateId in gateOpeningMap) {
    const gate = gateMap[gateId];
    gate_plan.push({
      gate_id: gateId,
      gate_name: gate ? gate.name : null,
      total_flow: gateOpeningMap[gateId].total_flow,
      unified_opening: gateOpeningMap[gateId].unified_opening,
      shared_by_irrigations: allocations
        .filter(a => a.gate_id === gateId && a.status === 'allocated')
        .map(a => ({
          irrigation_id: a.irrigation_id,
          irrigation_name: a.irrigation_name,
          share_flow: a.suggested_flow
        }))
    });
  }

  const record = {
    timestamp: Date.now(),
    inflow_rate: inflowRate,
    total_allocated: totalAllocated,
    maintenance_flow: reservedMaintenance,
    allocation_efficiency: allocationEfficiency,
    is_applied: 0,
    allocations_json: JSON.stringify(allocations),
    under_provisioned_json: JSON.stringify(underProvisioned),
    warnings_json: null
  };

  return {
    allocations,
    under_provisioned: underProvisioned,
    water_balance: waterBalance,
    gate_plan: gate_plan,
    is_water_restriction_mode: isWaterRestrictionMode,
    _record: record
  };
}

function checkWaterLevelSafety(allocations) {
  const seenGates = {};
  const adjustments = [];
  for (const a of allocations) {
    if (a.suggested_opening > 0 && !seenGates[a.gate_id]) {
      seenGates[a.gate_id] = true;
      adjustments.push({
        gateId: a.gate_id,
        newOpening: a.suggested_opening
      });
    }
  }

  if (adjustments.length === 0) {
    return { safe: true, violations: [] };
  }

  try {
    const predResult = predictionService.predictWaterLevels(adjustments);
    const violations = [];

    for (const pointId in predResult.predictions) {
      const pred = predResult.predictions[pointId];
      if (pred.safetyAlert && pred.safetyAlert.type === 'LOW') {
        violations.push({
          point_id: pointId,
          point_name: pred.pointName,
          segment_id: pred.segmentId,
          predicted_min_level: pred.safetyAlert.minLevel,
          safety_lower_limit: pred.safetyAlert.safetyLow,
          violation_type: 'WATER_LEVEL_TOO_LOW'
        });
      }
    }

    return {
      safe: violations.length === 0,
      violations,
      prediction_ref: predResult
    };
  } catch (err) {
    console.error('Safety check error:', err);
    return { safe: true, violations: [], warning: 'Safety prediction failed, skipped' };
  }
}

function saveDispatchRecord(record, warnings) {
  const now = Date.now();
  const result = prepare(`
    INSERT INTO dispatch_records
    (timestamp, inflow_rate, total_allocated, maintenance_flow, allocation_efficiency,
     is_applied, allocations_json, under_provisioned_json, warnings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.timestamp || now,
    record.inflow_rate,
    record.total_allocated,
    record.maintenance_flow,
    record.allocation_efficiency,
    record.is_applied || 0,
    record.allocations_json,
    record.under_provisioned_json,
    warnings ? JSON.stringify(warnings) : null
  );

  saveDatabase();
  return result.lastInsertRowid;
}

let lastOptimizationResult = null;

function setLastOptimization(result) {
  lastOptimizationResult = result;
}

function getLastOptimization() {
  return lastOptimizationResult;
}

function applyDispatch(recordId) {
  accumulateIrrigationsWaterUsage();

  let record;
  if (recordId) {
    record = prepare('SELECT * FROM dispatch_records WHERE id = ?').get(recordId);
  } else if (lastOptimizationResult && lastOptimizationResult._record) {
    record = lastOptimizationResult._record;
  }

  if (!record) {
    return { success: false, error: '未找到有效的调度方案,请先调用 optimize' };
  }

  const allocations = JSON.parse(record.allocations_json || '[]');

  const safetyCheck = checkWaterLevelSafety(allocations);
  if (!safetyCheck.safe) {
    return {
      success: false,
      error: '水位安全校验失败,调度方案被拒绝',
      violations: safetyCheck.violations
    };
  }

  const gateAdjustments = {};
  for (const alloc of allocations) {
    if (!gateAdjustments[alloc.gate_id]) {
      gateAdjustments[alloc.gate_id] = {
        gate_id: alloc.gate_id,
        unified_opening: alloc.gate_unified_opening != null ? alloc.gate_unified_opening : alloc.suggested_opening,
        total_flow: alloc.gate_total_flow || 0,
        irrigations: []
      };
    }
    gateAdjustments[alloc.gate_id].irrigations.push({
      irrigation_id: alloc.irrigation_id,
      irrigation_name: alloc.irrigation_name,
      share_flow: alloc.suggested_flow,
      status: alloc.status
    });
  }

  const appliedGates = [];
  for (const gateId in gateAdjustments) {
    const ga = gateAdjustments[gateId];
    try {
      const actualOpening = stateManager.updateGateOpening(gateId, ga.unified_opening);
      appliedGates.push({
        gate_id: gateId,
        target_opening: ga.unified_opening,
        actual_opening: actualOpening,
        total_flow: ga.total_flow,
        irrigations: ga.irrigations,
        status: 'success'
      });
    } catch (err) {
      appliedGates.push({
        gate_id: gateId,
        target_opening: ga.unified_opening,
        actual_opening: null,
        total_flow: ga.total_flow,
        irrigations: ga.irrigations,
        status: 'failed',
        error: err.message
      });
    }
  }

  const applied = [];
  for (const ga of appliedGates) {
    for (const irr of ga.irrigations) {
      applied.push({
        irrigation_id: irr.irrigation_id,
        irrigation_name: irr.irrigation_name,
        gate_id: ga.gate_id,
        target_opening: ga.target_opening,
        actual_opening: ga.actual_opening,
        target_flow: irr.share_flow,
        irrigation_status: irr.status,
        gate_status: ga.status,
        gate_error: ga.error
      });
    }
  }

  const now = Date.now();
  const warnings = safetyCheck.violations.length > 0 || safetyCheck.warning
    ? JSON.stringify({ violations: safetyCheck.violations, warning: safetyCheck.warning })
    : null;

  if (recordId) {
    prepare(`
      UPDATE dispatch_records SET is_applied = 1, warnings_json = ? WHERE id = ?
    `).run(warnings, recordId);
  } else if (lastOptimizationResult && lastOptimizationResult._record) {
    const savedId = saveDispatchRecord(lastOptimizationResult._record, safetyCheck.violations);
    prepare('UPDATE dispatch_records SET is_applied = 1 WHERE id = ?').run(savedId);
    recordId = savedId;
  }

  saveDatabase();
  updateDailySummary();

  return {
    success: true,
    record_id: recordId,
    applied_at: now,
    applied_gates: appliedGates,
    applied: applied,
    safety_check: {
      safe: safetyCheck.safe,
      violations: safetyCheck.violations,
      warning: safetyCheck.warning
    }
  };
}

function getDispatchHistory(days) {
  const nDays = parseInt(days) || 7;
  const cutoff = Date.now() - nDays * 24 * 3600 * 1000;

  const records = prepare(`
    SELECT * FROM dispatch_records
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
  `).all(cutoff);

  return records.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    inflow_rate: r.inflow_rate,
    total_allocated: r.total_allocated,
    maintenance_flow: r.maintenance_flow,
    allocation_efficiency_percent: r.allocation_efficiency,
    is_applied: r.is_applied === 1,
    allocations: JSON.parse(r.allocations_json || '[]'),
    under_provisioned: JSON.parse(r.under_provisioned_json || '[]'),
    warnings: r.warnings_json ? JSON.parse(r.warnings_json) : null
  }));
}

function updateDailySummary() {
  const today = getTodayStr();
  const now = Date.now();
  const irrigations = getAllIrrigationsWithStatus();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startTime = startOfDay.getTime();
  const endTime = startTime + 24 * 3600 * 1000;

  const records = prepare(`
    SELECT * FROM dispatch_records
    WHERE timestamp >= ? AND timestamp < ? AND is_applied = 1
  `).all(startTime, endTime);

  let totalSupply = 0;
  for (const r of records) {
    totalSupply += r.total_allocated;
  }

  const totalTaken = irrigations.reduce((s, i) => s + i.daily_taken, 0);
  const totalLoss = Math.max(0, totalSupply - totalTaken);

  const irrigationsSummary = irrigations.map(i => ({
    id: i.id,
    name: i.name,
    daily_quota: i.daily_quota,
    daily_taken: i.daily_taken,
    remaining_quota: i.remaining_quota,
    completion_rate: i.daily_quota > 0 ? Math.round((i.daily_taken / i.daily_quota) * 10000) / 100 : 0,
    priority: i.priority
  }));

  const existing = prepare('SELECT * FROM dispatch_daily_summary WHERE date = ?').get(today);
  if (existing) {
    prepare(`
      UPDATE dispatch_daily_summary SET
        total_supply = ?,
        total_taken = ?,
        total_loss = ?,
        irrigations_json = ?,
        updated_at = ?
      WHERE date = ?
    `).run(
      Math.round(totalSupply * 10000) / 10000,
      Math.round(totalTaken * 10000) / 10000,
      Math.round(totalLoss * 10000) / 10000,
      JSON.stringify(irrigationsSummary),
      now,
      today
    );
  } else {
    prepare(`
      INSERT INTO dispatch_daily_summary
      (date, total_supply, total_taken, total_loss, irrigations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      today,
      Math.round(totalSupply * 10000) / 10000,
      Math.round(totalTaken * 10000) / 10000,
      Math.round(totalLoss * 10000) / 10000,
      JSON.stringify(irrigationsSummary),
      now,
      now
    );
  }

  saveDatabase();
}

function getDailySummary() {
  updateDailySummary();
  const today = getTodayStr();
  const summary = prepare('SELECT * FROM dispatch_daily_summary WHERE date = ?').get(today);

  if (!summary) {
    return {
      date: today,
      total_supply: 0,
      total_taken: 0,
      total_loss: 0,
      loss_rate_percent: 0,
      irrigations: []
    };
  }

  const irrigations = JSON.parse(summary.irrigations_json || '[]');
  const lossRate = summary.total_supply > 0
    ? Math.round((summary.total_loss / summary.total_supply) * 10000) / 100
    : 0;

  return {
    date: summary.date,
    total_supply: summary.total_supply,
    total_taken: summary.total_taken,
    total_loss: summary.total_loss,
    loss_rate_percent: lossRate,
    irrigations: irrigations
  };
}

function initDemoIrrigations() {
  const existing = prepare('SELECT COUNT(*) as count FROM dispatch_irrigations').get();
  if (existing && existing.count > 0) return;

  const demoData = [
    { name: '灌区A', gate_id: 'gate3', daily_quota: 5000, priority: 1, min_flow: 0.1, max_flow: 0.8 },
    { name: '灌区B', gate_id: 'gate3', daily_quota: 3000, priority: 2, min_flow: 0.08, max_flow: 0.5 },
    { name: '灌区C', gate_id: 'gate3', daily_quota: 2000, priority: 3, min_flow: 0.05, max_flow: 0.3 }
  ];

  for (const data of demoData) {
    createIrrigation(data);
  }

  console.log('演示灌区初始化完成: 灌区A(优先级1,5000m³) + 灌区B(优先级2,3000m³) + 灌区C(优先级3,2000m³)');
}

module.exports = {
  createIrrigation,
  updateIrrigation,
  deleteIrrigation,
  getAllIrrigationsWithStatus,
  optimizeDispatch,
  applyDispatch,
  saveDispatchRecord,
  checkWaterLevelSafety,
  getDispatchHistory,
  getDailySummary,
  updateDailySummary,
  setLastOptimization,
  getLastOptimization,
  accumulateIrrigationsWaterUsage,
  solveGateOpeningForFlow,
  initDemoIrrigations
};
