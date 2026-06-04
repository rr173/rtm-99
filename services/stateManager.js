const { prepare, saveDatabase } = require('../db');

const currentState = {
  waterLevels: {},
  gateStates: {},
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
      discharge: 0
    };
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
    current_opening: clampedOpening
  };

  return clampedOpening;
}

function getState() {
  return { ...currentState };
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
  getState
};
