const { prepare, exec } = require('../db');
const geoUtils = require('./geoUtils');

const CHECKPOINT_RADIUS_METERS = 50;
const ANOMALY_POINT_RADIUS_METERS = 50;
const TIMEOUT_MULTIPLIER = 2;

function validateLatitude(lat) {
  if (typeof lat !== 'number' || isNaN(lat) || !isFinite(lat)) {
    return { valid: false, error: '纬度必须是有效的数字' };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, error: '纬度必须在-90到90之间' };
  }
  return { valid: true };
}

function validateLongitude(lon) {
  if (typeof lon !== 'number' || isNaN(lon) || !isFinite(lon)) {
    return { valid: false, error: '经度必须是有效的数字' };
  }
  if (lon < -180 || lon > 180) {
    return { valid: false, error: '经度必须在-180到180之间' };
  }
  return { valid: true };
}

function createRoute(name, estimatedDurationMinutes, checkpoints) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('路线名称不能为空');
  }
  if (!estimatedDurationMinutes || typeof estimatedDurationMinutes !== 'number' || estimatedDurationMinutes <= 0) {
    throw new Error('预计耗时必须是正整数(分钟)');
  }
  if (!Array.isArray(checkpoints) || checkpoints.length < 2) {
    throw new Error('巡检点至少需要2个');
  }

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    
    const latCheck = validateLatitude(cp.latitude);
    if (!latCheck.valid) {
      throw new Error(`第${i + 1}个巡检点${latCheck.error}`);
    }
    
    const lonCheck = validateLongitude(cp.longitude);
    if (!lonCheck.valid) {
      throw new Error(`第${i + 1}个巡检点${lonCheck.error}`);
    }
    
    if (!cp.canal_segment_id || typeof cp.canal_segment_id !== 'string') {
      throw new Error(`第${i + 1}个巡检点必须指定所属渠段ID`);
    }
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(cp.canal_segment_id);
    if (!seg) {
      throw new Error(`第${i + 1}个巡检点所属渠段不存在: ${cp.canal_segment_id}`);
    }
  }

  for (let i = 0; i < checkpoints.length - 1; i++) {
    const distance = geoUtils.haversineDistance(
      checkpoints[i].latitude, checkpoints[i].longitude,
      checkpoints[i + 1].latitude, checkpoints[i + 1].longitude
    );
    
    if (distance < 2) {
      throw new Error(`第${i + 1}个和第${i + 2}个巡检点距离过近(${Math.round(distance)}m)，相邻点间距至少需要2米`);
    }
    if (distance > 10000) {
      throw new Error(`第${i + 1}个和第${i + 2}个巡检点距离过远(${Math.round(distance)}m)，相邻点间距不能超过10公里`);
    }
  }

  const totalLength = geoUtils.calculateTotalDistance(checkpoints);
  const now = Date.now();

  const routeResult = prepare(`
    INSERT INTO patrol_routes (name, estimated_duration_minutes, total_length, created_at)
    VALUES (?, ?, ?, ?)
  `).run(name, estimatedDurationMinutes, totalLength, now);

  const routeId = routeResult.lastInsertRowid;

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    prepare(`
      INSERT INTO patrol_checkpoints (route_id, order_index, latitude, longitude, canal_segment_id, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(routeId, i + 1, cp.latitude, cp.longitude, cp.canal_segment_id, cp.description || null);
  }

  return getRouteDetail(routeId);
}

function getRouteList() {
  const routes = prepare('SELECT * FROM patrol_routes pr ORDER BY pr.created_at DESC').all();
  
  for (const route of routes) {
    const count = prepare('SELECT COUNT(*) as count FROM patrol_checkpoints WHERE route_id = ?').get(route.id);
    route.checkpoint_count = count ? count.count : 0;
  }
  
  return routes;
}

function getRouteDetail(routeId) {
  const id = parseInt(routeId);
  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(id);
  if (!route) {
    return null;
  }

  const checkpoints = prepare(`
    SELECT * FROM patrol_checkpoints 
    WHERE route_id = ? 
    ORDER BY order_index ASC
  `).all(id);

  return {
    ...route,
    checkpoints: checkpoints
  };
}

function createTask(routeId, inspectorName, plannedStartTime) {
  if (!routeId || typeof routeId !== 'number') {
    throw new Error('路线ID必须是数字');
  }
  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(routeId);
  if (!route) {
    throw new Error('巡检路线不存在');
  }
  if (!inspectorName || typeof inspectorName !== 'string' || inspectorName.trim().length === 0) {
    throw new Error('巡检员姓名不能为空');
  }
  if (!plannedStartTime || typeof plannedStartTime !== 'number') {
    throw new Error('计划开始时间不能为空(时间戳)');
  }

  const now = Date.now();
  const result = prepare(`
    INSERT INTO patrol_tasks (route_id, inspector_name, planned_start_time, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(routeId, inspectorName, plannedStartTime, now);

  return getTaskDetail(result.lastInsertRowid);
}

function getNextCheckpointToSign(taskId) {
  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw new Error('任务不存在');
  }

  const checkpoints = prepare(`
    SELECT * FROM patrol_checkpoints 
    WHERE route_id = ? 
    ORDER BY order_index ASC
  `).all(task.route_id);

  const signedCheckpoints = prepare(`
    SELECT DISTINCT checkpoint_id 
    FROM patrol_tracks 
    WHERE task_id = ? AND checkpoint_id IS NOT NULL
  `).all(taskId);

  const signedIds = new Set(signedCheckpoints.map(sc => sc.checkpoint_id));

  for (const cp of checkpoints) {
    if (!signedIds.has(cp.id)) {
      return cp;
    }
  }

  return null;
}

function reportTrack(taskId, latitude, longitude, timestamp) {
  if (!taskId || typeof taskId !== 'number') {
    throw new Error('任务ID必须是数字');
  }
  
  const latCheck = validateLatitude(latitude);
  if (!latCheck.valid) {
    throw new Error(latCheck.error);
  }
  
  const lonCheck = validateLongitude(longitude);
  if (!lonCheck.valid) {
    throw new Error(lonCheck.error);
  }
  
  if (!timestamp || typeof timestamp !== 'number') {
    throw new Error('时间戳不能为空');
  }

  let task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw new Error('任务不存在');
  }
  if (task.status === 'completed' || task.status === 'timeout') {
    throw new Error(`任务已${task.status === 'completed' ? '完成' : '超时'}，无法上报轨迹`);
  }

  if (task.status === 'pending') {
    prepare(`
      UPDATE patrol_tasks 
      SET status = 'in_progress', start_time = ?
      WHERE id = ?
    `).run(timestamp, taskId);
    task.status = 'in_progress';
    task.start_time = timestamp;
  }

  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(task.route_id);
  const startTime = task.start_time || task.planned_start_time;
  const timeoutMs = route.estimated_duration_minutes * 60 * 1000 * TIMEOUT_MULTIPLIER;
  const isTimeout = (timestamp - startTime) > timeoutMs;

  if (isTimeout) {
    prepare(`
      UPDATE patrol_tasks 
      SET status = 'timeout', end_time = ?
      WHERE id = ?
    `).run(timestamp, taskId);
    
    prepare(`
      INSERT INTO patrol_tracks (task_id, latitude, longitude, timestamp, checkpoint_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, latitude, longitude, timestamp, null);
    
    throw new Error('任务已超时，无法签到');
  }

  let signedCheckpointId = null;
  let signedCheckpoint = null;

  const nextCp = getNextCheckpointToSign(taskId);
  if (nextCp) {
    const distance = geoUtils.haversineDistance(
      latitude, longitude,
      nextCp.latitude, nextCp.longitude
    );

    if (distance <= CHECKPOINT_RADIUS_METERS) {
      signedCheckpointId = nextCp.id;
      signedCheckpoint = nextCp;
    }
  }

  prepare(`
    INSERT INTO patrol_tracks (task_id, latitude, longitude, timestamp, checkpoint_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, latitude, longitude, timestamp, signedCheckpointId);

  if (signedCheckpointId) {
    checkTaskCompletion(taskId, timestamp);
  }

  return {
    success: true,
    signedCheckpoint: signedCheckpoint ? {
      id: signedCheckpoint.id,
      order_index: signedCheckpoint.order_index,
      description: signedCheckpoint.description,
      signedAt: timestamp
    } : null
  };
}

function checkTaskCompletion(taskId, timestamp) {
  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(taskId);
  if (!task) return;
  if (task.status === 'timeout') return;

  const nextCp = getNextCheckpointToSign(taskId);
  if (!nextCp) {
    prepare(`
      UPDATE patrol_tasks 
      SET status = 'completed', end_time = ?
      WHERE id = ?
    `).run(timestamp, taskId);
  }
}

function checkTaskTimeout(taskId, timestamp) {
  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'in_progress') return;

  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(task.route_id);
  if (!route) return;

  const startTime = task.start_time || task.planned_start_time;
  const timeoutMs = route.estimated_duration_minutes * 60 * 1000 * TIMEOUT_MULTIPLIER;

  if (timestamp - startTime > timeoutMs) {
    prepare(`
      UPDATE patrol_tasks 
      SET status = 'timeout', end_time = ?
      WHERE id = ?
    `).run(timestamp, taskId);
  }
}

function getTaskList() {
  const tasks = prepare('SELECT * FROM patrol_tasks ORDER BY created_at DESC').all();
  const now = Date.now();

  for (const task of tasks) {
    if (task.status === 'in_progress') {
      checkTaskTimeout(task.id, now);
      task.status = prepare('SELECT status FROM patrol_tasks WHERE id = ?').get(task.id).status;
    }

    const route = prepare('SELECT name, estimated_duration_minutes FROM patrol_routes WHERE id = ?').get(task.route_id);
    task.route_name = route ? route.name : '路线已删除';

    const checkpointCount = prepare('SELECT COUNT(*) as count FROM patrol_checkpoints WHERE route_id = ?').get(task.route_id);
    const signedCount = prepare('SELECT COUNT(DISTINCT checkpoint_id) as count FROM patrol_tracks WHERE task_id = ? AND checkpoint_id IS NOT NULL').get(task.id);
    task.total_checkpoints = checkpointCount ? checkpointCount.count : 0;
    task.signed_checkpoints_count = signedCount ? signedCount.count : 0;
    task.progress_percent = task.total_checkpoints > 0 
      ? Math.round((task.signed_checkpoints_count / task.total_checkpoints) * 10000) / 100
      : 0;
  }

  return tasks;
}

function getTaskDetail(taskId) {
  const id = parseInt(taskId);
  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(id);
  if (!task) {
    return null;
  }

  if (task.status === 'in_progress') {
    checkTaskTimeout(task.id, Date.now());
    Object.assign(task, prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(id));
  }

  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(task.route_id);
  if (!route) {
    return { ...task, error: '关联路线已删除' };
  }

  const allCheckpoints = prepare(`
    SELECT * FROM patrol_checkpoints 
    WHERE route_id = ? 
    ORDER BY order_index ASC
  `).all(task.route_id);

  const tracks = prepare(`
    SELECT * FROM patrol_tracks 
    WHERE task_id = ? 
    ORDER BY timestamp ASC
  `).all(id);

  const signedIds = new Set(
    tracks.filter(t => t.checkpoint_id !== null).map(t => t.checkpoint_id)
  );

  const signedCheckpoints = allCheckpoints
    .filter(cp => signedIds.has(cp.id))
    .map(cp => {
      const signTrack = tracks.find(t => t.checkpoint_id === cp.id);
      return {
        ...cp,
        signed_at: signTrack ? signTrack.timestamp : null
      };
    });

  const unsignedCheckpoints = allCheckpoints.filter(cp => !signedIds.has(cp.id));

  const totalDistance = geoUtils.calculateTotalDistance(
    tracks.map(t => ({ latitude: t.latitude, longitude: t.longitude }))
  );

  const progress = allCheckpoints.length > 0 
    ? Math.round((signedCheckpoints.length / allCheckpoints.length) * 10000) / 100
    : 0;

  return {
    ...task,
    route_name: route.name,
    total_checkpoints: allCheckpoints.length,
    signed_checkpoints: signedCheckpoints,
    unsigned_checkpoints: unsignedCheckpoints,
    progress_percent: progress,
    total_distance_meters: Math.round(totalDistance),
    is_timeout: task.status === 'timeout',
    track_count: tracks.length
  };
}

function findNearestSegment(latitude, longitude) {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const segmentCoordinates = global.segmentCoordinates || {};

  let nearestSeg = null;
  let minDistance = Infinity;

  for (const seg of segments) {
    const coords = segmentCoordinates[seg.id];
    if (!coords) continue;

    const distance = geoUtils.pointToSegmentDistance(
      latitude, longitude,
      coords.start_lat, coords.start_lon,
      coords.end_lat, coords.end_lon
    );

    if (distance < minDistance) {
      minDistance = distance;
      nearestSeg = seg;
    }
  }

  if (nearestSeg) {
    return {
      segment: nearestSeg,
      distance: minDistance
    };
  }

  return null;
}

function findNearbyMeasurementPoint(latitude, longitude) {
  const points = prepare('SELECT * FROM measurement_points').all();
  const pointCoordinates = global.pointCoordinates || {};

  let nearestPoint = null;
  let minDistance = Infinity;

  for (const point of points) {
    const coords = pointCoordinates[point.id];
    if (!coords) continue;

    const distance = geoUtils.haversineDistance(
      latitude, longitude,
      coords.latitude, coords.longitude
    );

    if (distance <= ANOMALY_POINT_RADIUS_METERS && distance < minDistance) {
      minDistance = distance;
      nearestPoint = point;
    }
  }

  if (nearestPoint) {
    return {
      point: nearestPoint,
      distance: minDistance
    };
  }

  return null;
}

function reportAnomaly(taskId, latitude, longitude, type, description, severity) {
  if (!taskId || typeof taskId !== 'number') {
    throw new Error('任务ID必须是数字');
  }
  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw new Error('任务不存在');
  }
  
  const latCheck = validateLatitude(latitude);
  if (!latCheck.valid) {
    throw new Error(latCheck.error);
  }
  
  const lonCheck = validateLongitude(longitude);
  if (!lonCheck.valid) {
    throw new Error(lonCheck.error);
  }
  
  const validTypes = ['crack', 'leak', 'blockage', 'erosion', 'other'];
  if (!validTypes.includes(type)) {
    throw new Error('异常类型必须是: crack, leak, blockage, erosion, other');
  }
  const validSeverities = ['low', 'medium', 'high'];
  if (!validSeverities.includes(severity)) {
    throw new Error('严重程度必须是: low, medium, high');
  }

  const nearestSegResult = findNearestSegment(latitude, longitude);
  if (!nearestSegResult) {
    throw new Error('无法找到最近的渠段，请检查渠段坐标数据');
  }

  const nearbyPointResult = findNearbyMeasurementPoint(latitude, longitude);

  const now = Date.now();
  const result = prepare(`
    INSERT INTO patrol_anomalies (
      task_id, latitude, longitude, type, description, severity,
      segment_id, distance_to_segment, measurement_point_id, distance_to_point, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, latitude, longitude, type, description || null, severity,
    nearestSegResult.segment.id, Math.round(nearestSegResult.distance * 100) / 100,
    nearbyPointResult ? nearbyPointResult.point.id : null,
    nearbyPointResult ? Math.round(nearbyPointResult.distance * 100) / 100 : null,
    now
  );

  const anomaly = prepare('SELECT * FROM patrol_anomalies WHERE id = ?').get(result.lastInsertRowid);
  return anomaly;
}

function getAnomalyList(filters = {}) {
  let sql = 'SELECT pa.*, cs.name as segment_name, mp.name as point_name FROM patrol_anomalies pa ';
  sql += 'LEFT JOIN canal_segments cs ON pa.segment_id = cs.id ';
  sql += 'LEFT JOIN measurement_points mp ON pa.measurement_point_id = mp.id ';
  sql += 'WHERE 1=1 ';
  
  const params = [];

  if (filters.type) {
    sql += 'AND pa.type = ? ';
    params.push(filters.type);
  }
  if (filters.severity) {
    sql += 'AND pa.severity = ? ';
    params.push(filters.severity);
  }
  if (filters.segmentId) {
    sql += 'AND pa.segment_id = ? ';
    params.push(filters.segmentId);
  }
  if (filters.startTime) {
    sql += 'AND pa.timestamp >= ? ';
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    sql += 'AND pa.timestamp <= ? ';
    params.push(filters.endTime);
  }

  sql += 'ORDER BY pa.timestamp DESC';

  const anomalies = prepare(sql).all(...params);
  return {
    total: anomalies.length,
    anomalies: anomalies
  };
}

function getAnomalyStats() {
  const typeStats = prepare(`
    SELECT type, COUNT(*) as count 
    FROM patrol_anomalies 
    GROUP BY type
  `).all();

  const severityStats = prepare(`
    SELECT severity, COUNT(*) as count 
    FROM patrol_anomalies 
    GROUP BY severity
  `).all();

  const segments = prepare(`
    SELECT cs.id, cs.name, cs.length, COUNT(pa.id) as anomaly_count
    FROM canal_segments cs
    LEFT JOIN patrol_anomalies pa ON cs.id = pa.segment_id
    GROUP BY cs.id, cs.name, cs.length
    ORDER BY cs.order_index
  `).all();

  const segmentDensity = segments.map(seg => ({
    segment_id: seg.id,
    segment_name: seg.name,
    segment_length_km: seg.length / 1000,
    anomaly_count: seg.anomaly_count,
    density_per_km: seg.length > 0 ? Math.round((seg.anomaly_count / (seg.length / 1000)) * 100) / 100 : 0
  }));

  const typeMap = {};
  for (const ts of typeStats) {
    typeMap[ts.type] = ts.count;
  }

  const severityMap = {};
  for (const ss of severityStats) {
    severityMap[ss.severity] = ss.count;
  }

  return {
    total_anomalies: prepare('SELECT COUNT(*) as count FROM patrol_anomalies').get().count,
    by_type: typeMap,
    by_severity: severityMap,
    by_segment: segmentDensity
  };
}

module.exports = {
  createRoute,
  getRouteList,
  getRouteDetail,
  createTask,
  getTaskList,
  reportTrack,
  getTaskDetail,
  reportAnomaly,
  getAnomalyList,
  getAnomalyStats,
  findNearestSegment,
  findNearbyMeasurementPoint
};
