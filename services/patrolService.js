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
  if (!task || (task.status !== 'in_progress' && task.status !== 'pending')) return;

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
    if (task.status === 'in_progress' || task.status === 'pending') {
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

  if (task.status === 'in_progress' || task.status === 'pending') {
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
  createWorkOrderFromAnomaly(anomaly);
  return anomaly;
}

const SEVERITY_DEADLINE_HOURS = {
  low: 24,
  medium: 8,
  high: 4
};

function generateWorkOrderNumber() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const seqRow = prepare(`
    SELECT COUNT(*) as cnt FROM patrol_work_orders 
    WHERE order_number LIKE ?
  `).get('WO' + dateStr + '%');
  const seq = (seqRow ? seqRow.cnt : 0) + 1;
  return 'WO' + dateStr + seq.toString().padStart(4, '0');
}

function addTimelineEntry(workOrderId, statusFrom, statusTo, operator, remark) {
  const now = Date.now();
  prepare(`
    INSERT INTO patrol_work_order_timeline (work_order_id, status_from, status_to, operator, remark, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workOrderId, statusFrom || null, statusTo, operator || null, remark || null, now);
}

function createWorkOrderFromAnomaly(anomaly) {
  const orderNumber = generateWorkOrderNumber();
  const now = Date.now();

  const result = prepare(`
    INSERT INTO patrol_work_orders (
      order_number, anomaly_id, anomaly_type, anomaly_severity,
      segment_id, latitude, longitude, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    orderNumber, anomaly.id, anomaly.type, anomaly.severity,
    anomaly.segment_id, anomaly.latitude, anomaly.longitude, now
  );

  const workOrderId = result.lastInsertRowid;
  addTimelineEntry(workOrderId, null, 'pending', null, '异常上报自动创建工单');

  return getWorkOrderDetail(workOrderId);
}

function getWorkOrderDetail(id) {
  const workOrder = prepare(`
    SELECT pwo.*, cs.name as segment_name,
      pt.inspector_name as reporter_name
    FROM patrol_work_orders pwo
    LEFT JOIN canal_segments cs ON pwo.segment_id = cs.id
    LEFT JOIN patrol_anomalies pa ON pwo.anomaly_id = pa.id
    LEFT JOIN patrol_tasks pt ON pa.task_id = pt.id
    WHERE pwo.id = ?
  `).get(parseInt(id));

  if (!workOrder) return null;
  return workOrder;
}

function assignWorkOrders(workOrderIds, handlerName, assignedBy) {
  if (!Array.isArray(workOrderIds) || workOrderIds.length === 0) {
    throw new Error('工单ID列表不能为空');
  }
  if (!handlerName || typeof handlerName !== 'string' || handlerName.trim().length === 0) {
    throw new Error('处理人姓名不能为空');
  }

  const now = Date.now();
  const assigned = [];
  const failed = [];

  for (const rawId of workOrderIds) {
    const id = parseInt(rawId);
    const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(id);
    if (!wo) {
      failed.push({ id: rawId, reason: '工单不存在' });
      continue;
    }
    if (wo.status !== 'pending') {
      failed.push({ id: rawId, reason: '工单状态不是待指派,当前状态:' + wo.status });
      continue;
    }

    const deadlineHours = SEVERITY_DEADLINE_HOURS[wo.anomaly_severity] || 24;
    const deadline = now + deadlineHours * 60 * 60 * 1000;

    prepare(`
      UPDATE patrol_work_orders 
      SET status = 'assigned', assigned_at = ?, assigned_by = ?, handler_name = ?, deadline = ?
      WHERE id = ?
    `).run(now, assignedBy || null, handlerName, deadline, id);

    addTimelineEntry(id, 'pending', 'assigned', assignedBy || null, 
      `指派给处理人: ${handlerName}, 处理时限: ${deadlineHours}小时`);

    assigned.push(getWorkOrderDetail(id));
  }

  return { assigned: assigned, failed: failed };
}

function getWorkOrderList(filters = {}) {
  let sql = `
    SELECT pwo.*, cs.name as segment_name,
      pt.inspector_name as reporter_name
    FROM patrol_work_orders pwo
    LEFT JOIN canal_segments cs ON pwo.segment_id = cs.id
    LEFT JOIN patrol_anomalies pa ON pwo.anomaly_id = pa.id
    LEFT JOIN patrol_tasks pt ON pa.task_id = pt.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.status) {
    sql += ' AND pwo.status = ?';
    params.push(filters.status);
  }
  if (filters.handlerName) {
    sql += ' AND pwo.handler_name = ?';
    params.push(filters.handlerName);
  }
  if (filters.anomalyType) {
    sql += ' AND pwo.anomaly_type = ?';
    params.push(filters.anomalyType);
  }
  if (filters.segmentId) {
    sql += ' AND pwo.segment_id = ?';
    params.push(filters.segmentId);
  }
  if (filters.startTime) {
    sql += ' AND pwo.created_at >= ?';
    params.push(parseInt(filters.startTime));
  }
  if (filters.endTime) {
    sql += ' AND pwo.created_at <= ?';
    params.push(parseInt(filters.endTime));
  }

  sql += ' ORDER BY pwo.created_at DESC';

  const workOrders = prepare(sql).all(...params);
  return {
    total: workOrders.length,
    work_orders: workOrders
  };
}

function startWorkOrder(id, operator) {
  const woId = parseInt(id);
  const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(woId);
  if (!wo) {
    throw new Error('工单不存在');
  }
  if (wo.status !== 'assigned') {
    throw new Error('只有已指派的工单才能开始处理,当前状态:' + wo.status);
  }

  const now = Date.now();
  prepare(`
    UPDATE patrol_work_orders 
    SET status = 'processing'
    WHERE id = ?
  `).run(woId);

  addTimelineEntry(woId, 'assigned', 'processing', operator || wo.handler_name, 
    '处理人开始处理');

  return getWorkOrderDetail(woId);
}

function processWorkOrder(id, description, measures, operator) {
  const woId = parseInt(id);
  const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(woId);
  if (!wo) {
    throw new Error('工单不存在');
  }
  if (wo.status !== 'processing') {
    throw new Error('工单状态不允许提交处理结果,请先开始处理,当前状态:' + wo.status);
  }
  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('处理描述不能为空');
  }
  if (!measures || typeof measures !== 'string' || measures.trim().length === 0) {
    throw new Error('处理措施不能为空');
  }

  const now = Date.now();
  prepare(`
    UPDATE patrol_work_orders 
    SET status = 'verifying', process_description = ?, process_measures = ?, processed_at = ?
    WHERE id = ?
  `).run(description, measures, now, woId);

  addTimelineEntry(woId, 'processing', 'verifying', operator || wo.handler_name, 
    '提交处理结果,等待验收');

  return getWorkOrderDetail(woId);
}

function verifyWorkOrder(id, result, opinion, operator) {
  const woId = parseInt(id);
  const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(woId);
  if (!wo) {
    throw new Error('工单不存在');
  }
  if (wo.status !== 'verifying') {
    throw new Error('工单状态不允许验收,当前状态:' + wo.status);
  }
  if (!result || (result !== 'pass' && result !== 'reject')) {
    throw new Error('验收结果必须是 pass 或 reject');
  }

  const now = Date.now();
  let newStatus;
  let remark;

  if (result === 'pass') {
    newStatus = 'closed';
    remark = '验收通过,工单关闭' + (opinion ? ',验收意见:' + opinion : '');
    prepare(`
      UPDATE patrol_work_orders 
      SET status = 'closed', verify_result = 'pass', verify_opinion = ?, verified_at = ?, closed_at = ?
      WHERE id = ?
    `).run(opinion || null, now, now, woId);
  } else {
    newStatus = 'rejected';
    remark = '验收不通过,打回重做' + (opinion ? ',验收意见:' + opinion : '');
    prepare(`
      UPDATE patrol_work_orders 
      SET status = 'rejected', verify_result = 'reject', verify_opinion = ?, verified_at = ?
      WHERE id = ?
    `).run(opinion || null, now, woId);
  }

  addTimelineEntry(woId, 'verifying', newStatus, operator || null, remark);
  return getWorkOrderDetail(woId);
}

function reprocessWorkOrder(id, operator) {
  const woId = parseInt(id);
  const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(woId);
  if (!wo) {
    throw new Error('工单不存在');
  }
  if (wo.status !== 'rejected') {
    throw new Error('只有已打回的工单才能重新处理,当前状态:' + wo.status);
  }

  const now = Date.now();
  prepare(`
    UPDATE patrol_work_orders 
    SET status = 'processing'
    WHERE id = ?
  `).run(woId);

  addTimelineEntry(woId, 'rejected', 'processing', operator || wo.handler_name, 
    '处理人返工,重新开始处理');

  return getWorkOrderDetail(woId);
}

const SEVERITY_LEVEL = { low: 0, medium: 1, high: 2 };
const SEVERITY_BY_LEVEL = ['low', 'medium', 'high'];
const ESCALATION_INTERVAL_MS = 12 * 60 * 60 * 1000;

function calculateTargetSeverity(overdueHours, currentLevel) {
  let targetLevel = currentLevel;
  if (overdueHours >= 48) {
    targetLevel = 2;
  } else if (overdueHours >= 24) {
    targetLevel = Math.max(currentLevel, 1);
  } else if (overdueHours >= 12) {
    targetLevel = Math.max(currentLevel, 1);
  }
  return Math.min(targetLevel, 2);
}

function getOverdueWorkOrders() {
  const now = Date.now();
  const overdue = prepare(`
    SELECT pwo.*, cs.name as segment_name,
      pt.inspector_name as reporter_name
    FROM patrol_work_orders pwo
    LEFT JOIN canal_segments cs ON pwo.segment_id = cs.id
    LEFT JOIN patrol_anomalies pa ON pwo.anomaly_id = pa.id
    LEFT JOIN patrol_tasks pt ON pa.task_id = pt.id
    WHERE pwo.status != 'closed' 
      AND pwo.deadline IS NOT NULL 
      AND ? > pwo.deadline
    ORDER BY pwo.deadline ASC
  `).all(now);

  for (const wo of overdue) {
    const overdueMs = now - wo.deadline;
    const overdueHours = overdueMs / 3600000;
    const currentLevel = SEVERITY_LEVEL[wo.anomaly_severity] || 0;
    const targetLevel = calculateTargetSeverity(overdueHours, currentLevel);

    if (targetLevel <= currentLevel) continue;

    const lastEscalated = wo.last_escalated_at || 0;
    if (now - lastEscalated < ESCALATION_INTERVAL_MS && targetLevel === currentLevel + 1) continue;

    const newSeverity = SEVERITY_BY_LEVEL[targetLevel];
    const oldSeverity = wo.anomaly_severity;
    const escalationNote = `超时自动升级(${Math.round(overdueHours)}h): ${oldSeverity} -> ${newSeverity}`;

    prepare(`
      UPDATE patrol_work_orders 
      SET anomaly_severity = ?, 
          escalation_count = escalation_count + 1,
          last_escalated_at = ?,
          notes = COALESCE(notes || '; ', '') || ?
      WHERE id = ?
    `).run(newSeverity, now, escalationNote + ' @ ' + new Date(now).toISOString(), wo.id);

    addTimelineEntry(wo.id, wo.status, wo.status, 'system', escalationNote);
  }

  const refreshed = prepare(`
    SELECT pwo.*, cs.name as segment_name,
      pt.inspector_name as reporter_name
    FROM patrol_work_orders pwo
    LEFT JOIN canal_segments cs ON pwo.segment_id = cs.id
    LEFT JOIN patrol_anomalies pa ON pwo.anomaly_id = pa.id
    LEFT JOIN patrol_tasks pt ON pa.task_id = pt.id
    WHERE pwo.status != 'closed' 
      AND pwo.deadline IS NOT NULL 
      AND ? > pwo.deadline
    ORDER BY pwo.deadline ASC
  `).all(now);

  const result = refreshed.map(wo => ({
    ...wo,
    overdue_hours: Math.round(((now - wo.deadline) / 3600000) * 100) / 100
  }));

  return {
    total: result.length,
    overdue_work_orders: result
  };
}

function getWorkOrderTimeline(id) {
  const woId = parseInt(id);
  const wo = prepare('SELECT * FROM patrol_work_orders WHERE id = ?').get(woId);
  if (!wo) {
    throw new Error('工单不存在');
  }

  const timeline = prepare(`
    SELECT * FROM patrol_work_order_timeline 
    WHERE work_order_id = ? 
    ORDER BY timestamp ASC
  `).all(woId);

  return {
    work_order_id: woId,
    order_number: wo.order_number,
    timeline: timeline
  };
}

function getStartOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.getTime();
}

function calculateProcessingDurationHours(workOrderId) {
  const timeline = prepare(`
    SELECT status_from, status_to, timestamp
    FROM patrol_work_order_timeline
    WHERE work_order_id = ?
    ORDER BY timestamp ASC
  `).all(workOrderId);

  let totalMs = 0;
  let processingStart = null;

  for (const entry of timeline) {
    if (entry.status_to === 'processing') {
      processingStart = entry.timestamp;
    } else if (processingStart !== null && 
               (entry.status_to === 'verifying' || entry.status_to === 'closed' || entry.status_to === 'rejected')) {
      totalMs += entry.timestamp - processingStart;
      processingStart = null;
    }
  }
  return totalMs / 3600000;
}

function getWorkOrderDashboard() {
  const now = Date.now();
  const weekStart = getStartOfWeek(now);

  const statusCounts = prepare(`
    SELECT status, COUNT(*) as count 
    FROM patrol_work_orders 
    GROUP BY status
  `).all();

  const statusMap = { pending: 0, assigned: 0, processing: 0, verifying: 0, closed: 0, rejected: 0 };
  for (const s of statusCounts) {
    statusMap[s.status] = s.count;
  }

  const closedWOs = prepare(`
    SELECT id, assigned_at, closed_at
    FROM patrol_work_orders
    WHERE status = 'closed'
      AND assigned_at IS NOT NULL
      AND closed_at IS NOT NULL
  `).all();

  let totalProcessingHours = 0;
  let totalTurnaroundHours = 0;
  for (const wo of closedWOs) {
    totalProcessingHours += calculateProcessingDurationHours(wo.id);
    totalTurnaroundHours += (wo.closed_at - wo.assigned_at) / 3600000;
  }
  const avgProcessingHours = closedWOs.length > 0
    ? Math.round((totalProcessingHours / closedWOs.length) * 100) / 100
    : 0;
  const avgTurnaroundHours = closedWOs.length > 0
    ? Math.round((totalTurnaroundHours / closedWOs.length) * 100) / 100
    : 0;

  const totalResult = prepare('SELECT COUNT(*) as total FROM patrol_work_orders').get();
  const total = totalResult ? totalResult.total : 0;

  const overdueResult = prepare(`
    SELECT COUNT(*) as cnt 
    FROM patrol_work_orders 
    WHERE status != 'closed' 
      AND deadline IS NOT NULL 
      AND ? > deadline
  `).get(now);
  const overdueCount = overdueResult ? overdueResult.cnt : 0;
  const overdueRate = total > 0 ? Math.round((overdueCount / total) * 10000) / 100 : 0;

  const handlerRows = prepare(`
    SELECT DISTINCT handler_name
    FROM patrol_work_orders
    WHERE handler_name IS NOT NULL
  `).all();

  const handlerStatsFormatted = handlerRows.map(row => {
    const handler = row.handler_name;
    const handlerClosed = prepare(`
      SELECT id, assigned_at, closed_at
      FROM patrol_work_orders
      WHERE handler_name = ? AND status = 'closed'
        AND assigned_at IS NOT NULL AND closed_at IS NOT NULL
    `).all(handler);

    let procHours = 0;
    for (const hwo of handlerClosed) {
      procHours += calculateProcessingDurationHours(hwo.id);
    }
    return {
      handler_name: handler,
      completed_count: handlerClosed.length,
      avg_processing_hours: handlerClosed.length > 0
        ? Math.round((procHours / handlerClosed.length) * 100) / 100
        : 0
    };
  });

  const weekCreated = prepare(`
    SELECT COUNT(*) as cnt FROM patrol_work_orders WHERE created_at >= ?
  `).get(weekStart);

  const weekClosed = prepare(`
    SELECT COUNT(*) as cnt FROM patrol_work_orders WHERE closed_at >= ?
  `).get(weekStart);

  const dailyTrend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400000;

    const created = prepare(`
      SELECT COUNT(*) as cnt FROM patrol_work_orders WHERE created_at >= ? AND created_at < ?
    `).get(dayStart, dayEnd);

    const closed = prepare(`
      SELECT COUNT(*) as cnt FROM patrol_work_orders WHERE closed_at >= ? AND closed_at < ?
    `).get(dayStart, dayEnd);

    dailyTrend.push({
      date: d.toISOString().slice(0, 10),
      created: created ? created.cnt : 0,
      closed: closed ? closed.cnt : 0
    });
  }

  return {
    status_counts: statusMap,
    avg_processing_hours: avgProcessingHours,
    avg_turnaround_hours: avgTurnaroundHours,
    total_work_orders: total,
    overdue_count: overdueCount,
    overdue_rate: overdueRate,
    handler_stats: handlerStatsFormatted,
    week_summary: {
      start_timestamp: weekStart,
      new_work_orders: weekCreated ? weekCreated.cnt : 0,
      closed_work_orders: weekClosed ? weekClosed.cnt : 0
    },
    weekly_daily_trend: dailyTrend
  };
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

function calculateCompletionScore(completionRate) {
  return Math.round(completionRate * 40);
}

function calculateSpeedScore(totalDistanceMeters, durationMinutes) {
  if (durationMinutes <= 0 || totalDistanceMeters <= 0) return 0;
  
  const speedKmh = (totalDistanceMeters / 1000) / (durationMinutes / 60);
  
  if (speedKmh >= 2 && speedKmh <= 5) {
    return 20;
  } else if (speedKmh < 2) {
    return Math.round((speedKmh / 2) * 20);
  } else {
    const excess = speedKmh - 5;
    const penalty = Math.min(excess / 5, 1) * 20;
    return Math.max(0, Math.round(20 - penalty));
  }
}

function calculateAnomalyScore(anomalyCount) {
  const maxAnomalies = 5;
  const score = Math.min(anomalyCount, maxAnomalies) / maxAnomalies * 20;
  return Math.round(score);
}

function calculateTimelinessScore(durationMinutes, estimatedDurationMinutes) {
  if (estimatedDurationMinutes <= 0) return 20;
  if (durationMinutes <= 0) return 0;
  
  if (durationMinutes <= estimatedDurationMinutes) {
    return 20;
  } else {
    const excessRatio = (durationMinutes - estimatedDurationMinutes) / estimatedDurationMinutes;
    const penalty = Math.min(excessRatio, 1) * 20;
    return Math.max(0, Math.round(20 - penalty));
  }
}

function calculateCheckpointStayDurations(signedCheckpoints, taskEndTime) {
  const result = [];
  
  for (let i = 0; i < signedCheckpoints.length; i++) {
    const current = signedCheckpoints[i];
    const next = signedCheckpoints[i + 1];
    
    let stayDuration = 0;
    if (next) {
      stayDuration = Math.round((next.signed_at - current.signed_at) / 1000 / 60 * 100) / 100;
    } else if (taskEndTime) {
      stayDuration = Math.round((taskEndTime - current.signed_at) / 1000 / 60 * 100) / 100;
    }
    
    result.push({
      checkpoint_id: current.id,
      order_index: current.order_index,
      description: current.description,
      canal_segment_id: current.canal_segment_id,
      signed_at: current.signed_at,
      stay_duration_minutes: stayDuration
    });
  }
  
  return result;
}

function generateReport(taskId) {
  const id = parseInt(taskId);
  if (!id || typeof id !== 'number') {
    throw new Error('任务ID必须是数字');
  }

  const existingReport = prepare('SELECT * FROM patrol_reports WHERE task_id = ?').get(id);
  if (existingReport) {
    return getReportDetailByTaskId(id);
  }

  const task = prepare('SELECT * FROM patrol_tasks WHERE id = ?').get(id);
  if (!task) {
    throw new Error('任务不存在');
  }

  if (task.status !== 'completed' && task.status !== 'timeout') {
    throw new Error('只有已完成或已超时的任务才能生成报告');
  }

  const route = prepare('SELECT * FROM patrol_routes WHERE id = ?').get(task.route_id);
  if (!route) {
    throw new Error('关联路线不存在');
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
    })
    .sort((a, b) => a.signed_at - b.signed_at);

  const totalDistance = geoUtils.calculateTotalDistance(
    tracks.map(t => ({ latitude: t.latitude, longitude: t.longitude }))
  );

  const completionRate = allCheckpoints.length > 0 
    ? signedCheckpoints.length / allCheckpoints.length 
    : 0;

  const anomalies = prepare('SELECT * FROM patrol_anomalies WHERE task_id = ?').all(id);
  
  const anomalyByType = {};
  const anomalyBySeverity = {};
  for (const a of anomalies) {
    anomalyByType[a.type] = (anomalyByType[a.type] || 0) + 1;
    anomalyBySeverity[a.severity] = (anomalyBySeverity[a.severity] || 0) + 1;
  }

  const startTime = task.start_time || task.planned_start_time;
  const endTime = task.end_time || Date.now();
  const durationMinutes = Math.round((endTime - startTime) / 1000 / 60 * 100) / 100;

  const checkpointsDetail = calculateCheckpointStayDurations(signedCheckpoints, endTime);

  const completionScore = calculateCompletionScore(completionRate);
  const speedScore = calculateSpeedScore(totalDistance, durationMinutes);
  const anomalyScore = calculateAnomalyScore(anomalies.length);
  const timelinessScore = calculateTimelinessScore(durationMinutes, route.estimated_duration_minutes);
  const qualityScore = completionScore + speedScore + anomalyScore + timelinessScore;

  const now = Date.now();
  const result = prepare(`
    INSERT INTO patrol_reports (
      task_id, inspector_name, route_name, route_id,
      start_time, end_time, duration_minutes,
      total_distance_meters, total_checkpoints, signed_checkpoints, completion_rate,
      quality_score, completion_score, speed_score, anomaly_score, timeliness_score,
      anomaly_total, anomaly_by_type, anomaly_by_severity, checkpoints_detail,
      generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, task.inspector_name, route.name, task.route_id,
    startTime, endTime, durationMinutes,
    Math.round(totalDistance), allCheckpoints.length, signedCheckpoints.length, 
    Math.round(completionRate * 10000) / 10000,
    qualityScore, completionScore, speedScore, anomalyScore, timelinessScore,
    anomalies.length, JSON.stringify(anomalyByType), JSON.stringify(anomalyBySeverity),
    JSON.stringify(checkpointsDetail), now
  );

  return getReportDetail(result.lastInsertRowid);
}

function getReportDetail(reportId) {
  const id = parseInt(reportId);
  const report = prepare('SELECT * FROM patrol_reports WHERE id = ?').get(id);
  if (!report) return null;

  return formatReportDetail(report);
}

function getReportDetailByTaskId(taskId) {
  const id = parseInt(taskId);
  const report = prepare('SELECT * FROM patrol_reports WHERE task_id = ?').get(id);
  if (!report) return null;

  return formatReportDetail(report);
}

function formatReportDetail(report) {
  const anomalies = prepare(`
    SELECT pa.*, cs.name as segment_name 
    FROM patrol_anomalies pa
    LEFT JOIN canal_segments cs ON pa.segment_id = cs.id
    WHERE pa.task_id = ?
    ORDER BY pa.timestamp ASC
  `).all(report.task_id);

  return {
    id: report.id,
    task_id: report.task_id,
    task_basic: {
      inspector_name: report.inspector_name,
      route_name: report.route_name,
      route_id: report.route_id,
      start_time: report.start_time,
      end_time: report.end_time,
      duration_minutes: report.duration_minutes
    },
    overview: {
      total_distance_meters: report.total_distance_meters,
      total_checkpoints: report.total_checkpoints,
      signed_checkpoints: report.signed_checkpoints,
      completion_rate: report.completion_rate
    },
    quality_score: {
      total: report.quality_score,
      completion_score: report.completion_score,
      speed_score: report.speed_score,
      anomaly_score: report.anomaly_score,
      timeliness_score: report.timeliness_score
    },
    checkpoints_detail: report.checkpoints_detail ? JSON.parse(report.checkpoints_detail) : [],
    anomaly_summary: {
      total: report.anomaly_total,
      by_type: report.anomaly_by_type ? JSON.parse(report.anomaly_by_type) : {},
      by_severity: report.anomaly_by_severity ? JSON.parse(report.anomaly_by_severity) : {},
      anomalies: anomalies
    },
    generated_at: report.generated_at
  };
}

function getReportList(filters = {}) {
  let sql = 'SELECT pr.* FROM patrol_reports pr WHERE 1=1 ';
  const params = [];

  if (filters.inspectorName) {
    sql += 'AND pr.inspector_name = ? ';
    params.push(filters.inspectorName);
  }
  if (filters.startTime) {
    sql += 'AND pr.generated_at >= ? ';
    params.push(parseInt(filters.startTime));
  }
  if (filters.endTime) {
    sql += 'AND pr.generated_at <= ? ';
    params.push(parseInt(filters.endTime));
  }
  if (filters.minScore !== undefined) {
    sql += 'AND pr.quality_score >= ? ';
    params.push(parseFloat(filters.minScore));
  }
  if (filters.maxScore !== undefined) {
    sql += 'AND pr.quality_score <= ? ';
    params.push(parseFloat(filters.maxScore));
  }

  sql += 'ORDER BY pr.generated_at DESC';

  const reports = prepare(sql).all(...params);
  
  return {
    total: reports.length,
    reports: reports.map(r => ({
      id: r.id,
      task_id: r.task_id,
      inspector_name: r.inspector_name,
      route_name: r.route_name,
      start_time: r.start_time,
      end_time: r.end_time,
      duration_minutes: r.duration_minutes,
      total_distance_meters: r.total_distance_meters,
      completion_rate: r.completion_rate,
      quality_score: r.quality_score,
      anomaly_total: r.anomaly_total,
      generated_at: r.generated_at
    }))
  };
}

function getReportSummary() {
  const totalReports = prepare('SELECT COUNT(*) as count FROM patrol_reports').get().count;
  
  if (totalReports === 0) {
    return {
      total_reports: 0,
      average_score: 0,
      average_completion_rate: 0,
      top_high_anomaly_segments: []
    };
  }

  const avgStats = prepare(`
    SELECT 
      AVG(quality_score) as avg_score,
      AVG(completion_rate) as avg_completion
    FROM patrol_reports
  `).get();

  const segmentAnomalies = prepare(`
    SELECT 
      cs.id as segment_id,
      cs.name as segment_name,
      COUNT(pa.id) as anomaly_count
    FROM canal_segments cs
    LEFT JOIN patrol_anomalies pa ON cs.id = pa.segment_id
    GROUP BY cs.id, cs.name
    ORDER BY anomaly_count DESC
    LIMIT 3
  `).all();

  return {
    total_reports: totalReports,
    average_score: Math.round(avgStats.avg_score * 100) / 100,
    average_completion_rate: Math.round(avgStats.avg_completion * 10000) / 10000,
    top_high_anomaly_segments: segmentAnomalies.filter(s => s.anomaly_count > 0)
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
  findNearbyMeasurementPoint,
  generateReport,
  getReportDetail,
  getReportDetailByTaskId,
  getReportList,
  getReportSummary,
  assignWorkOrders,
  getWorkOrderList,
  getWorkOrderDetail,
  startWorkOrder,
  processWorkOrder,
  verifyWorkOrder,
  reprocessWorkOrder,
  getOverdueWorkOrders,
  getWorkOrderTimeline,
  getWorkOrderDashboard
};
