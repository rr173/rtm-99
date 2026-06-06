const { prepare, saveDatabase } = require('../db');
const stateManager = require('./stateManager');
const dispatchService = require('./dispatchService');

const MAINTENANCE_TYPES = ['lining', 'clearing', 'equipment', 'inspection'];
const MAINTENANCE_TYPE_NAMES = {
  lining: '衬砌修补',
  clearing: '清障',
  equipment: '设备更换',
  inspection: '例行检查'
};

function getDownstreamSegments(segmentId) {
  const allSegments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const startSeg = allSegments.find(s => s.id === segmentId);
  if (!startSeg) return [];
  return allSegments.filter(s => s.order_index >= startSeg.order_index);
}

function getUpstreamGates(segmentId) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) return [];
  
  const upstreamGates = [];
  
  const gatesOnSegment = prepare(`
    SELECT * FROM gates 
    WHERE canal_segment_id = ? 
    ORDER BY position_on_segment ASC
  `).all(segmentId);
  
  for (const g of gatesOnSegment) {
    if (g.position_on_segment <= 0.01 || g.type === 'regulator') {
      if (!upstreamGates.find(ug => ug.id === g.id)) {
        upstreamGates.push(g);
      }
    }
  }
  
  const controllingGate = prepare(`
    SELECT g.* FROM nodes n
    JOIN gates g ON n.gate_id = g.id
    WHERE n.downstream_segment_id = ?
  `).get(segmentId);
  
  if (controllingGate && !upstreamGates.find(ug => ug.id === controllingGate.id)) {
    upstreamGates.push(controllingGate);
  }
  
  return upstreamGates;
}

function getIrrigationsForSegments(segmentIds) {
  const gates = prepare(`
    SELECT * FROM gates 
    WHERE canal_segment_id IN (${segmentIds.map(() => '?').join(',')})
      AND type = 'diversion'
  `).all(...segmentIds);
  
  const gateIds = gates.map(g => g.id);
  if (gateIds.length === 0) return [];
  
  return prepare(`
    SELECT di.*, g.name as gate_name, g.canal_segment_id
    FROM dispatch_irrigations di
    JOIN gates g ON di.gate_id = g.id
    WHERE di.gate_id IN (${gateIds.map(() => '?').join(',')})
  `).all(...gateIds);
}

function calculateImpactAssessment(segmentId, durationHours) {
  const downstreamSegs = getDownstreamSegments(segmentId);
  const downstreamSegIds = downstreamSegs.map(s => s.id);
  
  const irrigations = getIrrigationsForSegments(downstreamSegIds);
  
  const affectedIrrigations = irrigations.map(irrig => {
    const resetIrrig = dispatchService['resetDailyQuotaIfNeeded'] 
      ? irrig 
      : irrig;
    
    let currentFlow = irrig.min_flow + (irrig.max_flow - irrig.min_flow) * 0.5;
    
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(irrig.gate_id);
    if (gate) {
      currentFlow = Math.max(irrig.min_flow, Math.min(irrig.max_flow, gate.current_opening * 0.5));
    }
    
    const lostQuota = currentFlow * durationHours * 3600;
    const dailyQuota = irrig.daily_quota || 0;
    const remainingQuota = Math.max(0, dailyQuota - (irrig.daily_taken || 0));
    const lossRatio = dailyQuota > 0 ? lostQuota / dailyQuota : 0;
    
    return {
      irrigation_id: irrig.id,
      irrigation_name: irrig.name,
      gate_id: irrig.gate_id,
      gate_name: irrig.gate_name,
      segment_id: irrig.canal_segment_id,
      priority: irrig.priority,
      current_allocated_flow: Math.round(currentFlow * 10000) / 10000,
      daily_quota: dailyQuota,
      remaining_quota: Math.round(remainingQuota * 100) / 100,
      estimated_lost_quota: Math.round(lostQuota * 100) / 100,
      loss_ratio_percent: Math.round(lossRatio * 10000) / 100,
      duration_hours: durationHours
    };
  });
  
  const totalLostQuota = affectedIrrigations.reduce((s, a) => s + a.estimated_lost_quota, 0);
  const totalAffectedPopulation = affectedIrrigations.length;
  
  return {
    segment_id: segmentId,
    duration_hours: durationHours,
    downstream_segments: downstreamSegs.map(s => ({
      id: s.id,
      name: s.name,
      order_index: s.order_index
    })),
    affected_irrigations: affectedIrrigations,
    total_affected_irrigations: totalAffectedPopulation,
    total_estimated_lost_quota: Math.round(totalLostQuota * 100) / 100,
    estimated_end_time: Date.now() + durationHours * 3600 * 1000
  };
}

function calculateAlternativeSupply(impactAssessment) {
  const alternatives = [];
  const affected = impactAssessment.affected_irrigations;
  
  for (const irrig of affected) {
    const remaining = irrig.remaining_quota;
    const lost = irrig.estimated_lost_quota;
    const canCompensate = remaining >= lost;
    
    alternatives.push({
      irrigation_id: irrig.irrigation_id,
      irrigation_name: irrig.irrigation_name,
      strategy: canCompensate ? 'self_compensation' : 'reduce_allocation',
      can_self_compensate: canCompensate,
      remaining_after_loss: Math.max(0, remaining - lost),
      compensation_shortfall: canCompensate ? 0 : Math.round((lost - remaining) * 100) / 100,
      suggested_action: canCompensate 
        ? `利用剩余配额补偿断水损失，断水后仍剩余 ${Math.round((remaining - lost) * 100) / 100} m³`
        : `配额不足，需减少 ${Math.round((lost - remaining) * 100) / 100} m³ 的供水，建议协调相邻灌区应急供水`
    });
  }
  
  const totalShortfall = alternatives.reduce((s, a) => s + a.compensation_shortfall, 0);
  
  return {
    alternatives: alternatives,
    total_shortfall: Math.round(totalShortfall * 100) / 100,
    overall_feasibility: totalShortfall === 0 ? 'feasible' : 'needs_coordination',
    recommendation: totalShortfall === 0
      ? '各灌区剩余配额足以补偿断水损失，可执行维护'
      : `存在 ${Math.round(totalShortfall * 100) / 100} m³ 的供水缺口，建议与高优先级灌区协调应急供水方案`
  };
}

function findBestMaintenanceWindow(segmentId, durationHours) {
  const impactAssessment = calculateImpactAssessment(segmentId, durationHours);
  const affected = impactAssessment.affected_irrigations;
  
  const now = Date.now();
  const hoursPerSlot = 4;
  const slotsPerDay = 24 / hoursPerSlot;
  const totalSlots = 7 * slotsPerDay;
  
  const windows = [];
  
  for (let i = 0; i < totalSlots; i++) {
    const startTime = now + i * hoursPerSlot * 3600 * 1000;
    const date = new Date(startTime);
    const hourOfDay = date.getHours();
    
    const dayProgress = hourOfDay / 24;
    let dailyTakenRatio = dayProgress;
    
    const avgRemainingRatio = affected.length > 0
      ? affected.reduce((s, a) => {
          const dailyQuota = a.daily_quota || 1;
          const projectedTaken = dailyQuota * dailyTakenRatio;
          const projectedRemaining = Math.max(0, dailyQuota - projectedTaken);
          return s + (projectedRemaining / dailyQuota);
        }, 0) / affected.length
      : 1;
    
    const isWorkHour = hourOfDay >= 8 && hourOfDay < 18;
    const workHourBonus = isWorkHour ? 0.1 : 0;
    const score = avgRemainingRatio + workHourBonus;
    
    windows.push({
      start_time: startTime,
      end_time: startTime + durationHours * 3600 * 1000,
      duration_hours: durationHours,
      is_work_hours: isWorkHour,
      hour_of_day: hourOfDay,
      avg_remaining_ratio: Math.round(avgRemainingRatio * 10000) / 100,
      suitability_score: Math.round(score * 10000) / 100
    });
  }
  
  windows.sort((a, b) => b.suitability_score - a.suitability_score);
  
  return {
    segment_id: segmentId,
    duration_hours: durationHours,
    scan_period_days: 7,
    slot_hours: hoursPerSlot,
    best_window: windows[0],
    top_windows: windows.slice(0, 5),
    recommendation: `建议在 ${new Date(windows[0].start_time).toLocaleString()} 开始维护，此时灌区平均剩余配额比最高 (${windows[0].avg_remaining_ratio}%)`
  };
}

function createMaintenancePlan(data) {
  const { segmentId, planStartTime, durationHours, maintenanceType, responsiblePerson, notes } = data;
  
  if (!segmentId) {
    throw new Error('渠段ID不能为空');
  }
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) {
    throw new Error('渠段不存在: ' + segmentId);
  }
  
  if (!planStartTime || isNaN(parseInt(planStartTime))) {
    throw new Error('计划开始时间必须是有效的时间戳');
  }
  
  if (!durationHours || isNaN(parseFloat(durationHours)) || parseFloat(durationHours) <= 0) {
    throw new Error('预计时长必须是正数(小时)');
  }
  
  if (!MAINTENANCE_TYPES.includes(maintenanceType)) {
    throw new Error('维护类型必须是: ' + MAINTENANCE_TYPES.join(', '));
  }
  
  const existingActive = prepare(`
    SELECT COUNT(*) as c FROM maintenance_plans
    WHERE segment_id = ? AND status IN ('scheduled', 'active')
  `).get(segmentId);
  
  if (existingActive.c > 0) {
    throw new Error('该渠段已有进行中或待执行的维护计划');
  }
  
  const impactAssessment = calculateImpactAssessment(segmentId, parseFloat(durationHours));
  const alternativeSupply = calculateAlternativeSupply(impactAssessment);
  
  const now = Date.now();
  
  const result = prepare(`
    INSERT INTO maintenance_plans (
      segment_id, plan_start_time, duration_hours, maintenance_type,
      responsible_person, status, impact_assessment_json, 
      alternative_supply_json, created_at, notes
    ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
  `).run(
    segmentId,
    parseInt(planStartTime),
    parseFloat(durationHours),
    maintenanceType,
    responsiblePerson || null,
    JSON.stringify(impactAssessment),
    JSON.stringify(alternativeSupply),
    now,
    notes || null
  );
  
  saveDatabase();
  
  return getMaintenancePlan(result.lastInsertRowid);
}

function getMaintenancePlans(filters) {
  const { status, segmentId } = filters || {};
  let sql = 'SELECT * FROM maintenance_plans WHERE 1=1';
  const params = [];
  
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (segmentId) {
    sql += ' AND segment_id = ?';
    params.push(segmentId);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  const plans = prepare(sql).all(...params);
  
  return plans.map(p => formatPlanSummary(p));
}

function formatPlanSummary(plan) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(plan.segment_id);
  return {
    id: plan.id,
    segment_id: plan.segment_id,
    segment_name: seg ? seg.name : null,
    plan_start_time: plan.plan_start_time,
    duration_hours: plan.duration_hours,
    maintenance_type: plan.maintenance_type,
    maintenance_type_name: MAINTENANCE_TYPE_NAMES[plan.maintenance_type] || plan.maintenance_type,
    responsible_person: plan.responsible_person,
    status: plan.status,
    created_at: plan.created_at,
    started_at: plan.started_at,
    completed_at: plan.completed_at,
    cancelled_at: plan.cancelled_at,
    notes: plan.notes
  };
}

function getMaintenancePlan(id) {
  const plan = prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(parseInt(id));
  if (!plan) return null;
  
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(plan.segment_id);
  const upstreamGates = getUpstreamGates(plan.segment_id);
  
  let impactAssessment = null;
  let alternativeSupply = null;
  let gateSnapshot = null;
  
  try {
    impactAssessment = plan.impact_assessment_json ? JSON.parse(plan.impact_assessment_json) : null;
  } catch (e) {}
  try {
    alternativeSupply = plan.alternative_supply_json ? JSON.parse(plan.alternative_supply_json) : null;
  } catch (e) {}
  try {
    gateSnapshot = plan.gate_snapshot_json ? JSON.parse(plan.gate_snapshot_json) : null;
  } catch (e) {}
  
  return {
    id: plan.id,
    segment_id: plan.segment_id,
    segment_name: seg ? seg.name : null,
    plan_start_time: plan.plan_start_time,
    duration_hours: plan.duration_hours,
    maintenance_type: plan.maintenance_type,
    maintenance_type_name: MAINTENANCE_TYPE_NAMES[plan.maintenance_type] || plan.maintenance_type,
    responsible_person: plan.responsible_person,
    status: plan.status,
    created_at: plan.created_at,
    started_at: plan.started_at,
    completed_at: plan.completed_at,
    cancelled_at: plan.cancelled_at,
    notes: plan.notes,
    upstream_gates: upstreamGates.map(g => ({
      id: g.id,
      name: g.name,
      type: g.type,
      current_opening: g.current_opening,
      max_opening: g.max_opening
    })),
    impact_assessment: impactAssessment,
    alternative_supply: alternativeSupply,
    gate_snapshot: gateSnapshot
  };
}

function cancelMaintenancePlan(id) {
  const plan = prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(parseInt(id));
  if (!plan) {
    return { error: '维护计划不存在' };
  }
  
  if (plan.status === 'completed') {
    return { error: '已完成的维护计划无法取消' };
  }
  if (plan.status === 'cancelled') {
    return { error: '该维护计划已取消' };
  }
  
  if (plan.status === 'active') {
    return { error: '进行中的维护计划无法取消，请先完成维护' };
  }
  
  const now = Date.now();
  prepare(`
    UPDATE maintenance_plans SET status = 'cancelled', cancelled_at = ? WHERE id = ?
  `).run(now, parseInt(id));
  
  saveDatabase();
  
  return getMaintenancePlan(id);
}

function startMaintenancePlan(id) {
  const plan = prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(parseInt(id));
  if (!plan) {
    return { error: '维护计划不存在' };
  }
  
  if (plan.status === 'completed') {
    return { error: '已完成的维护计划无法重复执行' };
  }
  if (plan.status === 'cancelled') {
    return { error: '已取消的维护计划无法执行' };
  }
  if (plan.status === 'active') {
    return { error: '该维护计划已在执行中' };
  }
  
  const upstreamGates = getUpstreamGates(plan.segment_id);
  
  const gateSnapshot = upstreamGates.map(gate => ({
    gate_id: gate.id,
    gate_name: gate.name,
    previous_opening: gate.current_opening,
    max_opening: gate.max_opening
  }));
  
  const gateChanges = [];
  
  for (const gate of upstreamGates) {
    const previousOpening = gate.current_opening;
    const wasLocked = stateManager.isGateLocked(gate.id);
    stateManager.lockGate(gate.id, 'maintenance', plan.id);
    
    if (!wasLocked) {
      stateManager.updateGateOpening(gate.id, 0);
      gateChanges.push({
        gate_id: gate.id,
        gate_name: gate.name,
        previous_opening: previousOpening,
        current_opening: 0,
        action: 'closed_and_locked'
      });
    } else {
      gateChanges.push({
        gate_id: gate.id,
        gate_name: gate.name,
        previous_opening: previousOpening,
        current_opening: previousOpening,
        action: 'already_locked_by_other_plan'
      });
    }
  }
  
  const now = Date.now();
  prepare(`
    UPDATE maintenance_plans 
    SET status = 'active', started_at = ?, gate_snapshot_json = ?
    WHERE id = ?
  `).run(now, JSON.stringify(gateSnapshot), parseInt(id));
  
  saveDatabase();
  
  const updatedPlan = getMaintenancePlan(id);
  const closedCount = gateChanges.filter(g => g.action === 'closed_and_locked').length;
  const alreadyLockedCount = gateChanges.filter(g => g.action === 'already_locked_by_other_plan').length;
  let message = `维护已开始，已关闭并锁定 ${closedCount} 个上游闸门`;
  if (alreadyLockedCount > 0) {
    message += `（另有 ${alreadyLockedCount} 个闸门已被其他维护计划锁定）`;
  }
  
  return {
    success: true,
    plan: updatedPlan,
    gate_changes: gateChanges,
    started_at: now,
    message: message
  };
}

function completeMaintenancePlan(id) {
  const plan = prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(parseInt(id));
  if (!plan) {
    return { error: '维护计划不存在' };
  }
  
  if (plan.status !== 'active') {
    return { error: '只有进行中的维护计划可以完成' };
  }
  
  let gateSnapshot = [];
  try {
    gateSnapshot = plan.gate_snapshot_json ? JSON.parse(plan.gate_snapshot_json) : [];
  } catch (e) {}
  
  const otherActivePlans = prepare(`
    SELECT id, segment_id FROM maintenance_plans
    WHERE status = 'active' AND id != ?
  `).all(parseInt(id));
  
  const otherPlanGateIds = new Set();
  for (const op of otherActivePlans) {
    const opGates = getUpstreamGates(op.segment_id);
    for (const g of opGates) {
      otherPlanGateIds.add(g.id);
    }
  }
  
  const gateChanges = [];
  
  for (const snap of gateSnapshot) {
    const stillNeeded = otherPlanGateIds.has(snap.gate_id);
    
    if (!stillNeeded) {
      stateManager.updateGateOpening(snap.gate_id, snap.previous_opening);
      stateManager.unlockGate(snap.gate_id, plan.id);
      gateChanges.push({
        gate_id: snap.gate_id,
        gate_name: snap.gate_name,
        previous_opening: 0,
        current_opening: snap.previous_opening,
        action: 'restored_and_unlocked'
      });
    } else {
      stateManager.unlockGate(snap.gate_id, plan.id);
      const lockInfo = stateManager.getGateLockInfo(snap.gate_id);
      gateChanges.push({
        gate_id: snap.gate_id,
        gate_name: snap.gate_name,
        previous_opening: 0,
        current_opening: 0,
        action: 'kept_locked_by_other_plan',
        remaining_lock_count: lockInfo.maintenance_plan_ids ? lockInfo.maintenance_plan_ids.length : 0
      });
    }
  }
  
  const now = Date.now();
  prepare(`
    UPDATE maintenance_plans 
    SET status = 'completed', completed_at = ?
    WHERE id = ?
  `).run(now, parseInt(id));
  
  saveDatabase();
  
  const updatedPlan = getMaintenancePlan(id);
  const restoredCount = gateChanges.filter(g => g.action === 'restored_and_unlocked').length;
  const keptLockedCount = gateChanges.filter(g => g.action === 'kept_locked_by_other_plan').length;
  let message = `维护已完成，已恢复并解锁 ${restoredCount} 个闸门`;
  if (keptLockedCount > 0) {
    message += `（${keptLockedCount} 个闸门因其他维护计划仍保持锁定）`;
  }
  
  return {
    success: true,
    plan: updatedPlan,
    gate_changes: gateChanges,
    completed_at: now,
    message: message
  };
}

function getActiveMaintenanceSegmentIds() {
  const active = prepare(`
    SELECT DISTINCT segment_id FROM maintenance_plans
    WHERE status = 'active'
  `).all();
  return active.map(p => p.segment_id);
}

module.exports = {
  MAINTENANCE_TYPES,
  MAINTENANCE_TYPE_NAMES,
  getDownstreamSegments,
  getUpstreamGates,
  calculateImpactAssessment,
  calculateAlternativeSupply,
  findBestMaintenanceWindow,
  createMaintenancePlan,
  getMaintenancePlans,
  getMaintenancePlan,
  cancelMaintenancePlan,
  startMaintenancePlan,
  completeMaintenancePlan,
  getActiveMaintenanceSegmentIds
};
