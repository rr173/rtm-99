const { prepare } = require('../db');
const stateManager = require('./stateManager');
const predictionService = require('./predictionService');
const hydraulicEngine = require('./hydraulicEngine');
const siltationService = require('./siltationService');

function createPlan(planData) {
  const { name, conditions, actions, priority = 3, effectiveStartTime, effectiveEndTime } = planData;
  const now = Date.now();

  if (!name || !name.trim()) {
    throw new Error('预案名称不能为空');
  }

  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('至少需要一个触发条件');
  }

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    throw new Error('至少需要一个响应动作');
  }

  if (actions.length > 8) {
    throw new Error('响应动作最多不超过8个');
  }

  for (const cond of conditions) {
    if (!['water_level', 'gate_fault', 'flow_change'].includes(cond.type)) {
      throw new Error(`无效的条件类型: ${cond.type}`);
    }
    if (!cond.targetId) {
      throw new Error('条件缺少目标ID');
    }
    if (cond.threshold === undefined) {
      throw new Error('条件缺少阈值');
    }
  }

  const result = prepare(`
    INSERT INTO emergency_plans (name, priority, effective_start_time, effective_end_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name.trim(), priority, effectiveStartTime || null, effectiveEndTime || null, now, now);

  const planId = result.lastInsertRowid;

  for (const cond of conditions) {
    prepare(`
      INSERT INTO emergency_plan_conditions (plan_id, type, target_id, operator, threshold, tolerance, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(planId, cond.type, cond.targetId, cond.operator || '>', cond.threshold, cond.tolerance || null, cond.durationSeconds || null);
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    prepare(`
      INSERT INTO emergency_plan_actions (plan_id, order_index, gate_id, target_opening, adjustment_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(planId, i, action.gateId, action.targetOpening, action.adjustmentType || 'absolute');
  }

  return getPlanById(planId);
}

function getPlanById(planId) {
  const plan = prepare('SELECT * FROM emergency_plans WHERE id = ?').get(planId);
  if (!plan) return null;

  const conditions = prepare('SELECT * FROM emergency_plan_conditions WHERE plan_id = ?').all(planId);
  const actions = prepare('SELECT * FROM emergency_plan_actions WHERE plan_id = ? ORDER BY order_index').all(planId);

  return {
    id: plan.id,
    name: plan.name,
    priority: plan.priority,
    enabled: plan.enabled === 1,
    effectiveStartTime: plan.effective_start_time,
    effectiveEndTime: plan.effective_end_time,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    conditions: conditions.map(c => ({
      id: c.id,
      type: c.type,
      targetId: c.target_id,
      operator: c.operator,
      threshold: c.threshold,
      tolerance: c.tolerance,
      durationSeconds: c.duration_seconds
    })),
    actions: actions.map(a => ({
      id: a.id,
      orderIndex: a.order_index,
      gateId: a.gate_id,
      targetOpening: a.target_opening,
      adjustmentType: a.adjustment_type
    }))
  };
}

function getAllPlans() {
  const plans = prepare('SELECT * FROM emergency_plans ORDER BY priority, created_at').all();
  return plans.map(p => {
    const conditions = prepare('SELECT * FROM emergency_plan_conditions WHERE plan_id = ?').all(p.id);
    const actions = prepare('SELECT * FROM emergency_plan_actions WHERE plan_id = ? ORDER BY order_index').all(p.id);
    return {
      id: p.id,
      name: p.name,
      priority: p.priority,
      enabled: p.enabled === 1,
      effectiveStartTime: p.effective_start_time,
      effectiveEndTime: p.effective_end_time,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      conditions: conditions.map(c => ({
        id: c.id,
        type: c.type,
        targetId: c.target_id,
        operator: c.operator,
        threshold: c.threshold,
        tolerance: c.tolerance,
        durationSeconds: c.duration_seconds
      })),
      actions: actions.map(a => ({
        id: a.id,
        orderIndex: a.order_index,
        gateId: a.gate_id,
        targetOpening: a.target_opening,
        adjustmentType: a.adjustment_type
      }))
    };
  });
}

function updatePlan(planId, planData) {
  const existing = prepare('SELECT * FROM emergency_plans WHERE id = ?').get(planId);
  if (!existing) {
    throw new Error('预案不存在');
  }

  const { name, conditions, actions, priority, enabled, effectiveStartTime, effectiveEndTime } = planData;
  const now = Date.now();

  prepare(`
    UPDATE emergency_plans 
    SET name = ?, priority = ?, enabled = ?, effective_start_time = ?, effective_end_time = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name !== undefined ? name : existing.name,
    priority !== undefined ? priority : existing.priority,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    effectiveStartTime !== undefined ? effectiveStartTime : existing.effective_start_time,
    effectiveEndTime !== undefined ? effectiveEndTime : existing.effective_end_time,
    now,
    planId
  );

  if (conditions !== undefined) {
    prepare('DELETE FROM emergency_plan_conditions WHERE plan_id = ?').run(planId);
    for (const cond of conditions) {
      prepare(`
        INSERT INTO emergency_plan_conditions (plan_id, type, target_id, operator, threshold, tolerance, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(planId, cond.type, cond.targetId, cond.operator || '>', cond.threshold, cond.tolerance || null, cond.durationSeconds || null);
    }
  }

  if (actions !== undefined) {
    if (actions.length > 8) {
      throw new Error('响应动作最多不超过8个');
    }
    prepare('DELETE FROM emergency_plan_actions WHERE plan_id = ?').run(planId);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      prepare(`
        INSERT INTO emergency_plan_actions (plan_id, order_index, gate_id, target_opening, adjustment_type)
        VALUES (?, ?, ?, ?, ?)
      `).run(planId, i, action.gateId, action.targetOpening, action.adjustmentType || 'absolute');
    }
  }

  return getPlanById(planId);
}

function deletePlan(planId) {
  const existing = prepare('SELECT * FROM emergency_plans WHERE id = ?').get(planId);
  if (!existing) {
    throw new Error('预案不存在');
  }

  prepare('DELETE FROM emergency_plan_actions WHERE plan_id = ?').run(planId);
  prepare('DELETE FROM emergency_plan_conditions WHERE plan_id = ?').run(planId);
  prepare('DELETE FROM emergency_plans WHERE id = ?').run(planId);

  return { success: true };
}

function checkWaterLevelCondition(condition) {
  const currentLevel = stateManager.getCurrentWaterLevel(condition.targetId);
  if (currentLevel === null || currentLevel === undefined) {
    return { triggered: false, currentValue: null };
  }

  let triggered = false;
  switch (condition.operator) {
    case '>':
      triggered = currentLevel > condition.threshold;
      break;
    case '<':
      triggered = currentLevel < condition.threshold;
      break;
    case '>=':
      triggered = currentLevel >= condition.threshold;
      break;
    case '<=':
      triggered = currentLevel <= condition.threshold;
      break;
    default:
      triggered = currentLevel > condition.threshold;
  }

  return {
    triggered,
    currentValue: currentLevel,
    description: `测点${condition.targetId}水位 ${currentLevel.toFixed(2)}m ${condition.operator} ${condition.threshold}m`
  };
}

function recordGateDeviation(gateId, deviation) {
  const pointId = `gate_${gateId}_deviation`;
  prepare(`
    INSERT INTO water_level_history (point_id, water_level, timestamp)
    VALUES (?, ?, ?)
  `).run(pointId, deviation, Date.now());
}

function checkGateFaultCondition(condition) {
  const gate = prepare('SELECT * FROM gates WHERE id = ?').get(condition.targetId);
  if (!gate) {
    return { triggered: false, currentValue: null };
  }

  const gateState = stateManager.getGateState(condition.targetId);
  const targetOpening = gateState?.target_opening ?? gate.current_opening;
  const deviation = Math.abs(gate.current_opening - targetOpening);
  const tolerance = condition.tolerance ?? 0.1;

  recordGateDeviation(condition.targetId, deviation);

  let triggered = deviation > tolerance;

  if (condition.duration_seconds && triggered) {
    const startTime = Date.now() - condition.duration_seconds * 1000;
    const recentDeviations = prepare(`
      SELECT water_level FROM water_level_history 
      WHERE point_id = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `).all(`gate_${condition.targetId}_deviation`, startTime);

    const allAboveTolerance = recentDeviations.length > 0 && 
      recentDeviations.every(d => d.water_level > tolerance);
    
    const hasEnoughData = recentDeviations.length >= Math.min(10, Math.floor(condition.duration_seconds / 10));
    
    triggered = allAboveTolerance && hasEnoughData;
  }

  return {
    triggered,
    currentValue: deviation,
    description: `闸门${condition.targetId}开度偏差 ${deviation.toFixed(3)}m > ${tolerance}m`,
    currentOpening: gate.current_opening,
    targetOpening: targetOpening
  };
}

function checkFlowChangeCondition(condition) {
  const gate = prepare('SELECT * FROM gates WHERE id = ?').get(condition.targetId);
  if (!gate) {
    return { triggered: false, currentValue: null };
  }

  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const history = prepare(`
    SELECT water_level, timestamp FROM water_level_history 
    WHERE point_id = ? AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(`gate_${condition.targetId}_flow`, tenMinutesAgo);

  if (history.length < 2) {
    return { triggered: false, currentValue: 0 };
  }

  const currentFlow = calculateGateFlow(gate);
  const oldestFlow = history[history.length - 1].water_level;
  
  const changeRate = oldestFlow > 0 ? Math.abs((currentFlow - oldestFlow) / oldestFlow) * 100 : 0;
  const thresholdPercent = condition.threshold;

  const triggered = changeRate > thresholdPercent;

  return {
    triggered,
    currentValue: changeRate,
    description: `闸门${condition.targetId}流量变化率 ${changeRate.toFixed(1)}% > ${thresholdPercent}%`,
    currentFlow,
    previousFlow: oldestFlow
  };
}

function calculateGateFlow(gate) {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  
  const seg = segments.find(s => s.id === gate.canal_segment_id);
  if (!seg) return 0;

  const upPoint = points.find(p => p.gate_id === gate.id && p.type === 'upstream_gate');
  const downPoint = points.find(p => p.gate_id === gate.id && p.type === 'downstream_gate');

  const hUp = upPoint ? stateManager.getCurrentWaterLevel(upPoint.id) : null;
  const hDown = downPoint ? stateManager.getCurrentWaterLevel(downPoint.id) : null;

  if (hUp === null || hDown === null) return 0;

  const depthUp = hUp - seg.bottom_elevation;
  const depthDown = hDown - seg.bottom_elevation;

  return hydraulicEngine.calculateGateDischarge(gate, depthUp, depthDown);
}

function isPlanEffective(plan) {
  if (!plan.enabled) return false;

  if (!plan.effectiveStartTime && !plan.effectiveEndTime) return true;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (plan.effectiveStartTime && plan.effectiveEndTime) {
    return currentTime >= plan.effectiveStartTime && currentTime <= plan.effectiveEndTime;
  }

  return true;
}

function checkAllPlans() {
  const startTime = Date.now();
  const plans = getAllPlans();
  const triggeredPlans = [];

  for (const plan of plans) {
    if (!isPlanEffective(plan)) continue;

    const conditionResults = [];
    let anyTriggered = false;

    for (const condition of plan.conditions) {
      let result;
      switch (condition.type) {
        case 'water_level':
          result = checkWaterLevelCondition(condition);
          break;
        case 'gate_fault':
          result = checkGateFaultCondition(condition);
          break;
        case 'flow_change':
          result = checkFlowChangeCondition(condition);
          break;
        default:
          result = { triggered: false };
      }

      conditionResults.push({
        condition,
        ...result
      });

      if (result.triggered) {
        anyTriggered = true;
      }
    }

    if (anyTriggered) {
      const triggeredConditions = conditionResults.filter(c => c.triggered);
      triggeredPlans.push({
        plan,
        triggerReason: triggeredConditions.map(c => c.description).join('; '),
        triggerConditions: triggeredConditions,
        suggestedActions: plan.actions
      });
    }
  }

  triggeredPlans.sort((a, b) => {
    if (a.plan.priority !== b.plan.priority) {
      return a.plan.priority - b.plan.priority;
    }
    return a.plan.createdAt - b.plan.createdAt;
  });

  const activatedPlan = triggeredPlans.length > 0 ? triggeredPlans[0] : null;

  return {
    scanTimeMs: Date.now() - startTime,
    totalPlans: plans.length,
    effectivePlans: plans.filter(p => isPlanEffective(p)).length,
    triggeredCount: triggeredPlans.length,
    triggeredPlans: triggeredPlans.map(t => ({
      planId: t.plan.id,
      planName: t.plan.name,
      priority: t.plan.priority,
      triggerReason: t.triggerReason
    })),
    activatedPlan: activatedPlan ? {
      planId: activatedPlan.plan.id,
      planName: activatedPlan.plan.name,
      priority: activatedPlan.plan.priority,
      triggerReason: activatedPlan.triggerReason,
      triggerDetails: activatedPlan.triggerConditions.map(c => ({
        type: c.condition.type,
        targetId: c.condition.targetId,
        currentValue: c.currentValue,
        threshold: c.condition.threshold,
        operator: c.condition.operator
      })),
      suggestedActions: activatedPlan.suggestedActions
    } : null
  };
}

async function simulatePlan(planId) {
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('预案不存在');
  }

  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  const segments = prepare('SELECT * FROM canal_segments').all();

  const adjustments = [];
  const actionEffects = [];

  for (const action of plan.actions) {
    const gate = gates.find(g => g.id === action.gateId);
    if (!gate) continue;

    let targetOpening;
    if (action.adjustmentType === 'relative') {
      targetOpening = gate.current_opening * (1 + action.targetOpening / 100);
    } else {
      targetOpening = action.targetOpening;
    }
    targetOpening = Math.max(0, Math.min(gate.max_opening, targetOpening));

    adjustments.push({
      gateId: action.gateId,
      newOpening: targetOpening
    });

    const upPoint = points.find(p => p.gate_id === gate.id && p.type === 'upstream_gate');
    const downPoint = points.find(p => p.gate_id === gate.id && p.type === 'downstream_gate');

    actionEffects.push({
      gateId: action.gateId,
      gateName: gate.name,
      previousOpening: gate.current_opening,
      targetOpening: targetOpening,
      adjustmentType: action.adjustmentType,
      upstreamPointId: upPoint?.id,
      downstreamPointId: downPoint?.id
    });
  }

  const predictionResult = predictionService.predictWaterLevels(adjustments);

  for (const effect of actionEffects) {
    if (effect.upstreamPointId) {
      const upPred = predictionResult.predictions[effect.upstreamPointId];
      if (upPred && upPred.timeSeries.length > 0) {
        effect.upstreamLevelBefore = upPred.timeSeries[0].waterLevel;
        effect.upstreamLevelAfter = upPred.timeSeries[upPred.timeSeries.length - 1].waterLevel;
        effect.upstreamLevelChange = effect.upstreamLevelAfter - effect.upstreamLevelBefore;
      }
    }
    if (effect.downstreamPointId) {
      const downPred = predictionResult.predictions[effect.downstreamPointId];
      if (downPred && downPred.timeSeries.length > 0) {
        effect.downstreamLevelBefore = downPred.timeSeries[0].waterLevel;
        effect.downstreamLevelAfter = downPred.timeSeries[downPred.timeSeries.length - 1].waterLevel;
        effect.downstreamLevelChange = effect.downstreamLevelAfter - effect.downstreamLevelBefore;
      }
    }
  }

  let hasRemainingRisk = false;
  const riskDetails = [];
  for (const pointId in predictionResult.predictions) {
    const pred = predictionResult.predictions[pointId];
    if (pred.safetyAlert) {
      hasRemainingRisk = true;
      riskDetails.push({
        pointId: pointId,
        pointName: pred.pointName,
        alertType: pred.safetyAlert.type,
        minLevel: pred.safetyAlert.minLevel,
        maxLevel: pred.safetyAlert.maxLevel
      });
    }
  }

  const executionId = recordExecution(plan, 'simulate', '预案演练', {
    hasRemainingRisk,
    riskDetails,
    actionEffects
  });

  return {
    executionId,
    planId: plan.id,
    planName: plan.name,
    predictionResult: {
      computeTimeMs: predictionResult.computeTimeMs,
      timeHorizonMinutes: predictionResult.timeHorizonMinutes,
      predictions: predictionResult.predictions,
      gateDischarges: predictionResult.gateDischarges
    },
    actionEffects,
    riskAssessment: {
      hasRemainingRisk,
      riskLevel: hasRemainingRisk ? 'high' : 'low',
      message: hasRemainingRisk ? '预案不足以消除风险，仍有测点越限' : '预案执行后无测点越限风险',
      details: riskDetails
    }
  };
}

function recordExecution(plan, executionType, triggerReason, extraData = {}) {
  const now = Date.now();
  const initialState = captureSystemState();

  const result = prepare(`
    INSERT INTO emergency_executions (plan_id, plan_name, trigger_reason, execution_type, status, started_at, initial_state, risk_assessment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    plan.id,
    plan.name,
    triggerReason,
    executionType,
    'completed',
    now,
    JSON.stringify(initialState),
    JSON.stringify(extraData.riskAssessment || extraData)
  );

  const executionId = result.lastInsertRowid;

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    prepare(`
      INSERT INTO emergency_execution_actions (execution_id, order_index, gate_id, target_opening, status, executed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(executionId, i, action.gateId, action.targetOpening, 'success', now + i * 1000);
  }

  prepare(`
    UPDATE emergency_executions SET completed_at = ?, final_state = ? WHERE id = ?
  `).run(Date.now(), JSON.stringify(captureSystemState()), executionId);

  return executionId;
}

function captureSystemState() {
  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();

  const gateStates = {};
  for (const gate of gates) {
    gateStates[gate.id] = {
      opening: gate.current_opening,
      maxOpening: gate.max_opening
    };
  }

  const waterLevels = {};
  for (const point of points) {
    waterLevels[point.id] = stateManager.getCurrentWaterLevel(point.id);
  }

  return {
    timestamp: Date.now(),
    gates: gateStates,
    waterLevels: waterLevels
  };
}

async function executePlan(planId) {
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('预案不存在');
  }

  const now = Date.now();
  const initialState = captureSystemState();

  const execResult = prepare(`
    INSERT INTO emergency_executions (plan_id, plan_name, trigger_reason, execution_type, status, started_at, initial_state)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.name, '手动执行', 'real', 'running', now, JSON.stringify(initialState));

  const executionId = execResult.lastInsertRowid;
  const actionResults = [];

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    const gate = prepare('SELECT * FROM gates WHERE id = ?').get(action.gateId);

    if (!gate) {
      actionResults.push({
        orderIndex: i,
        gateId: action.gateId,
        status: 'failed',
        error: '闸门不存在'
      });
      recordExecutionAction(executionId, i, action.gateId, action.targetOpening, 'failed', '闸门不存在');
      continue;
    }

    let targetOpening;
    if (action.adjustmentType === 'relative') {
      targetOpening = gate.current_opening * (1 + action.targetOpening / 100);
    } else {
      targetOpening = action.targetOpening;
    }

    if (targetOpening < 0 || targetOpening > gate.max_opening) {
      actionResults.push({
        orderIndex: i,
        gateId: action.gateId,
        gateName: gate.name,
        targetOpening: targetOpening,
        previousOpening: gate.current_opening,
        status: 'skipped',
        error: `目标开度 ${targetOpening.toFixed(2)}m 超出范围 [0, ${gate.max_opening}m]`
      });
      recordExecutionAction(executionId, i, action.gateId, targetOpening, 'skipped', '目标开度超出范围');
      continue;
    }

    try {
      if (stateManager.isGateLocked(action.gateId)) {
        throw new Error('该闸门因维护计划锁定中');
      }
      const previousOpening = gate.current_opening;
      const actualOpening = stateManager.updateGateOpening(action.gateId, targetOpening);
      
      updateSystemStateAfterAdjustment();
      await delay(10000);

      actionResults.push({
        orderIndex: i,
        gateId: action.gateId,
        gateName: gate.name,
        previousOpening: previousOpening,
        actualOpening: actualOpening,
        status: 'success'
      });
      recordExecutionAction(executionId, i, action.gateId, targetOpening, 'success', null, previousOpening, actualOpening);
    } catch (err) {
      actionResults.push({
        orderIndex: i,
        gateId: action.gateId,
        gateName: gate.name,
        targetOpening: targetOpening,
        previousOpening: gate.current_opening,
        status: 'failed',
        error: err.message
      });
      recordExecutionAction(executionId, i, action.gateId, targetOpening, 'failed', err.message);
    }
  }

  const finalState = captureSystemState();
  prepare(`
    UPDATE emergency_executions SET status = ?, completed_at = ?, final_state = ?
    WHERE id = ?
  `).run('completed', Date.now(), JSON.stringify(finalState), executionId);

  const stateComparison = compareStates(initialState, finalState);

  return {
    executionId,
    planId: plan.id,
    planName: plan.name,
    completedAt: Date.now(),
    actionResults,
    stateComparison
  };
}

function recordExecutionAction(executionId, orderIndex, gateId, targetOpening, status, error, previousOpening = null, actualOpening = null) {
  prepare(`
    INSERT INTO emergency_execution_actions (execution_id, order_index, gate_id, target_opening, previous_opening, actual_opening, status, error_message, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(executionId, orderIndex, gateId, targetOpening, previousOpening, actualOpening, status, error, Date.now());
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateSystemStateAfterAdjustment() {
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

  const now = Date.now();
  for (const point of points) {
    const seg = segments.find(s => s.id === point.canal_segment_id);
    const ss = seg ? steadyState[seg.id] : null;
    if (ss) {
      const distRatio = point.distance_from_upstream / seg.length;
      const waterLevel = ss.upstreamLevel + distRatio * (ss.downstreamLevel - ss.upstreamLevel);
      stateManager.updateWaterLevel(point.id, waterLevel, now);
    }
  }

  for (const gate of gates) {
    const seg = segments.find(s => s.id === gate.canal_segment_id);
    const ss = seg ? steadyState[seg.id] : null;
    if (ss) {
      const gateState = stateManager.getGateState(gate.id);
      if (gateState) {
        gateState.discharge = gate.type === 'diversion' ? ss.diversionFlow : ss.flow;
      }
    }
  }

  return steadyState;
}

function compareStates(initial, final) {
  const gateChanges = {};
  for (const gateId in initial.gates) {
    const init = initial.gates[gateId];
    const fin = final.gates[gateId];
    gateChanges[gateId] = {
      before: init?.opening,
      after: fin?.opening,
      change: fin?.opening - init?.opening
    };
  }

  const waterLevelChanges = {};
  for (const pointId in initial.waterLevels) {
    const init = initial.waterLevels[pointId];
    const fin = final.waterLevels[pointId];
    if (init !== null && fin !== null) {
      waterLevelChanges[pointId] = {
        before: init,
        after: fin,
        change: fin - init
      };
    }
  }

  return {
    gateChanges,
    waterLevelChanges
  };
}

function getExecutions() {
  const executions = prepare(`
    SELECT * FROM emergency_executions 
    ORDER BY started_at DESC 
    LIMIT 100
  `).all();

  return executions.map(e => ({
    id: e.id,
    planId: e.plan_id,
    planName: e.plan_name,
    triggerReason: e.trigger_reason,
    executionType: e.execution_type,
    status: e.status,
    startedAt: e.started_at,
    completedAt: e.completed_at
  }));
}

function getExecutionDetail(executionId) {
  const execution = prepare('SELECT * FROM emergency_executions WHERE id = ?').get(executionId);
  if (!execution) return null;

  const actions = prepare(`
    SELECT * FROM emergency_execution_actions 
    WHERE execution_id = ? 
    ORDER BY order_index
  `).all(executionId);

  return {
    id: execution.id,
    planId: execution.plan_id,
    planName: execution.plan_name,
    triggerReason: execution.trigger_reason,
    executionType: execution.execution_type,
    status: execution.status,
    startedAt: execution.started_at,
    completedAt: execution.completed_at,
    initialState: execution.initial_state ? JSON.parse(execution.initial_state) : null,
    finalState: execution.final_state ? JSON.parse(execution.final_state) : null,
    riskAssessment: execution.risk_assessment ? JSON.parse(execution.risk_assessment) : null,
    actions: actions.map(a => ({
      id: a.id,
      orderIndex: a.order_index,
      gateId: a.gate_id,
      targetOpening: a.target_opening,
      previousOpening: a.previous_opening,
      actualOpening: a.actual_opening,
      status: a.status,
      errorMessage: a.error_message,
      executedAt: a.executed_at
    }))
  };
}

module.exports = {
  createPlan,
  getPlanById,
  getAllPlans,
  updatePlan,
  deletePlan,
  checkAllPlans,
  simulatePlan,
  executePlan,
  getExecutions,
  getExecutionDetail
};
