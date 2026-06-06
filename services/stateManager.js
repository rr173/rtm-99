const { prepare, saveDatabase } = require('../db');

const currentState = {
  waterLevels: {},
  gateStates: {},
  gateLocks: {},
  lastUpdate: Date.now()
};

function initState() {
  const points = prepare('SELECT * FROM measurement_points').all();
  const gates = prepare('SELECT * FROM gates').all();

  for (const point of points) {
    const latest = prepare(`
      SELECT water_level FROM water_level_history 
      WHERE point_id = ? 
      ORDER BY timestamp DESC LIMIT 1
    `).get(point.id);
    
    currentState.waterLevels[point.id] = latest ? latest.water_level : null;
  }

  for (const gate of gates) {
    currentState.gateStates[gate.id] = {
      current_opening: gate.current_opening,
      target_opening: gate.current_opening,
      discharge: 0
    };
    currentState.gateLocks[gate.id] = {
      locked: false,
      reason: null,
      maintenance_plan_id: null,
      locked_at: null
    };
  }

  const activePlans = prepare(`
    SELECT id, segment_id FROM maintenance_plans WHERE status = 'active'
  `).all();
  
  for (const plan of activePlans) {
    const upstreamGates = prepare(`
      SELECT g.id FROM gates g
      WHERE g.canal_segment_id = ? AND g.position_on_segment <= 0.01
      UNION
      SELECT g.id FROM gates g
      WHERE g.canal_segment_id = ? AND g.type = 'regulator'
    `).all(plan.segment_id, plan.segment_id);
    
    for (const gate of upstreamGates) {
      currentState.gateLocks[gate.id] = {
        locked: true,
        reason: 'maintenance',
        maintenance_plan_id: plan.id,
        locked_at: Date.now()
      };
    }
  }

  currentState.lastUpdate = Date.now();
}

function getCurrentWaterLevel(pointId) {
  return currentState.waterLevels[pointId];
}

function getSegmentWaterLevels(segmentId) {
  const points = prepare(`
    SELECT * FROM measurement_points 
    WHERE canal_segment_id = ? 
    ORDER BY distance_from_upstream
  `).all(segmentId);

  const levels = {};
  for (const p of points) {
    levels[p.id] = currentState.waterLevels[p.id];
  }
  
  const upstreamPoint = points.find(p => p.distance_from_upstream <= 0.01);
  const segLength = prepare('SELECT length FROM canal_segments WHERE id = ?').get(segmentId);
  const downstreamPoint = points.find(p => Math.abs(p.distance_from_upstream - 
    (segLength?.length || 0)) < 1);

  return {
    points: levels,
    upstream: upstreamPoint ? currentState.waterLevels[upstreamPoint.id] : null,
    downstream: downstreamPoint ? currentState.waterLevels[downstreamPoint.id] : null
  };
}

function getAllSegmentWaterLevels() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const result = {};
  
  for (const seg of segments) {
    const segLevels = getSegmentWaterLevels(seg.id);
    result[seg.id] = {
      upstream: segLevels.upstream,
      downstream: segLevels.downstream
    };
  }
  
  return result;
}

function updateWaterLevel(pointId, waterLevel, timestamp) {
  prepare(`
    INSERT INTO water_level_history (point_id, water_level, timestamp)
    VALUES (?, ?, ?)
  `).run(pointId, waterLevel, timestamp);

  currentState.waterLevels[pointId] = waterLevel;
  currentState.lastUpdate = Date.now();

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  prepare(`
    DELETE FROM water_level_history WHERE timestamp < ?
  `).run(cutoff);
}

function updateWaterLevelsBatch(data) {
  const stmt = prepare(`
    INSERT INTO water_level_history (point_id, water_level, timestamp)
    VALUES (?, ?, ?)
  `);

  for (const item of data) {
    stmt.run(item.pointId, item.waterLevel, item.timestamp);
    currentState.waterLevels[item.pointId] = item.waterLevel;
  }

  saveDatabase();
  currentState.lastUpdate = Date.now();

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  prepare(`DELETE FROM water_level_history WHERE timestamp < ?`).run(cutoff);
}

function getGateState(gateId) {
  return currentState.gateStates[gateId];
}

function updateGateOpening(gateId, newOpening) {
  const gate = prepare('SELECT * FROM gates WHERE id = ?').get(gateId);
  if (!gate) return null;

  const clampedOpening = Math.max(0, Math.min(gate.max_opening, newOpening));
  
  prepare(`
    UPDATE gates SET current_opening = ? WHERE id = ?
  `).run(clampedOpening, gateId);

  currentState.gateStates[gateId] = {
    ...currentState.gateStates[gateId],
    current_opening: clampedOpening,
    target_opening: clampedOpening
  };

  return clampedOpening;
}

function setGateTargetOpening(gateId, targetOpening) {
  if (!currentState.gateStates[gateId]) return null;

  currentState.gateStates[gateId] = {
    ...currentState.gateStates[gateId],
    target_opening: targetOpening
  };

  return targetOpening;
}

function getState() {
  return { ...currentState };
}

function isGateLocked(gateId) {
  const lock = currentState.gateLocks[gateId];
  return lock ? lock.locked : false;
}

function getGateLockInfo(gateId) {
  return currentState.gateLocks[gateId] || { locked: false, reason: null, maintenance_plan_id: null, locked_at: null };
}

function lockGate(gateId, reason, maintenancePlanId) {
  if (!currentState.gateLocks[gateId]) {
    currentState.gateLocks[gateId] = {
      locked: false,
      reason: null,
      maintenance_plan_id: null,
      locked_at: null
    };
  }
  currentState.gateLocks[gateId] = {
    locked: true,
    reason: reason || 'maintenance',
    maintenance_plan_id: maintenancePlanId || null,
    locked_at: Date.now()
  };
  return currentState.gateLocks[gateId];
}

function unlockGate(gateId) {
  if (!currentState.gateLocks[gateId]) {
    currentState.gateLocks[gateId] = {
      locked: false,
      reason: null,
      maintenance_plan_id: null,
      locked_at: null
    };
  }
  currentState.gateLocks[gateId] = {
    locked: false,
    reason: null,
    maintenance_plan_id: null,
    locked_at: null
  };
  return currentState.gateLocks[gateId];
}

function getAllGateLocks() {
  return { ...currentState.gateLocks };
}

module.exports = {
  initState,
  getCurrentWaterLevel,
  getSegmentWaterLevels,
  getAllSegmentWaterLevels,
  updateWaterLevel,
  updateWaterLevelsBatch,
  getGateState,
  updateGateOpening,
  setGateTargetOpening,
  getState,
  isGateLocked,
  getGateLockInfo,
  lockGate,
  unlockGate,
  getAllGateLocks
};
