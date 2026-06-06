const { prepare, exec, saveDatabase } = require('../db');

const VALID_OPERATION_TYPES = [
  'gate_adjust',
  'gate_target_set',
  'siltation_set',
  'maintenance_start',
  'maintenance_complete',
  'dispatch_apply',
  'emergency_execute',
  'emergency_simulate',
  'telemetry_batch',
  'operation_denied',
  'ice_dispatch_apply',
  'water_quality_lockdown_apply',
  'water_quality_lockdown_release'
];

const WORK_START_HOUR = 8;
const WORK_END_HOUR = 18;

function isValidOperationType(type) {
  return VALID_OPERATION_TYPES.includes(type);
}

function writeAuditLog(logData) {
  const {
    operationType,
    operator = 'system',
    targetId = null,
    beforeState = null,
    afterState = null,
    sourceIp = null,
    requestBody = null,
    responseStatus = null,
    responseBody = null,
    deniedReason = null
  } = logData;

  if (!isValidOperationType(operationType)) {
    throw new Error(`无效的操作类型: ${operationType}`);
  }

  const timestamp = Date.now();
  const beforeJson = beforeState !== null ? JSON.stringify(beforeState) : null;
  const afterJson = afterState !== null ? JSON.stringify(afterState) : null;
  const reqBodyJson = requestBody !== null ? JSON.stringify(requestBody) : null;
  const resBodyJson = responseBody !== null ? JSON.stringify(responseBody) : null;

  const result = prepare(`
    INSERT INTO audit_logs (
      timestamp, operation_type, operator, target_id,
      before_state, after_state, source_ip, request_body,
      response_status, response_body, denied_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp, operationType, operator, targetId,
    beforeJson, afterJson, sourceIp, reqBodyJson,
    responseStatus, resBodyJson, deniedReason
  );

  saveDatabase();

  return {
    id: result.lastInsertRowid,
    timestamp,
    operationType
  };
}

function getLogById(id) {
  const log = prepare('SELECT * FROM audit_logs WHERE id = ?').get(parseInt(id));
  if (!log) return null;

  return parseLogRow(log);
}

function parseLogRow(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    operationType: row.operation_type,
    operator: row.operator,
    targetId: row.target_id,
    beforeState: row.before_state ? JSON.parse(row.before_state) : null,
    afterState: row.after_state ? JSON.parse(row.after_state) : null,
    sourceIp: row.source_ip,
    requestBody: row.request_body ? JSON.parse(row.request_body) : null,
    responseStatus: row.response_status,
    responseBody: row.response_body ? JSON.parse(row.response_body) : null,
    deniedReason: row.denied_reason
  };
}

function queryLogs(filters = {}) {
  const {
    type,
    operator,
    target,
    startTime,
    endTime,
    page = 1,
    pageSize = 50
  } = filters;

  let safePage = parseInt(page) || 1;
  let safePageSize = parseInt(pageSize) || 50;
  if (safePage < 1) safePage = 1;
  if (safePageSize < 1) safePageSize = 50;
  if (safePageSize > 200) safePageSize = 200;

  const where = [];
  const params = [];

  if (type) {
    where.push('operation_type = ?');
    params.push(type);
  }
  if (operator) {
    where.push('operator = ?');
    params.push(operator);
  }
  if (target) {
    where.push('target_id = ?');
    params.push(target);
  }
  if (startTime) {
    where.push('timestamp >= ?');
    params.push(parseInt(startTime));
  }
  if (endTime) {
    where.push('timestamp <= ?');
    params.push(parseInt(endTime));
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const countResult = prepare(
    `SELECT COUNT(*) as total FROM audit_logs ${whereSql}`
  ).get(...params);
  const total = countResult ? countResult.total : 0;

  const offset = (safePage - 1) * safePageSize;
  const rows = prepare(`
    SELECT * FROM audit_logs ${whereSql}
    ORDER BY timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safePageSize, offset);

  const logs = rows.map(parseLogRow);

  return {
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.ceil(total / safePageSize) || 1,
    logs
  };
}

function getSummary(startTime, endTime) {
  const where = [];
  const params = [];

  if (startTime) {
    where.push('timestamp >= ?');
    params.push(parseInt(startTime));
  }
  if (endTime) {
    where.push('timestamp <= ?');
    params.push(parseInt(endTime));
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const byTypeRows = prepare(`
    SELECT operation_type, COUNT(*) as count FROM audit_logs
    ${whereSql}
    GROUP BY operation_type
    ORDER BY count DESC
  `).all(...params);

  const byOperatorRows = prepare(`
    SELECT operator, COUNT(*) as count FROM audit_logs
    ${whereSql}
    GROUP BY operator
    ORDER BY count DESC
    LIMIT 20
  `).all(...params);

  const deniedWhere = ['operation_type = ?'];
  const deniedParams = ['operation_denied'];
  if (startTime) { deniedWhere.push('timestamp >= ?'); deniedParams.push(parseInt(startTime)); }
  if (endTime) { deniedWhere.push('timestamp <= ?'); deniedParams.push(parseInt(endTime)); }
  const deniedSql = 'WHERE ' + deniedWhere.join(' AND ');
  const deniedCount = prepare(
    `SELECT COUNT(*) as count FROM audit_logs ${deniedSql}`
  ).get(...deniedParams);

  const byHourRows = prepare(`
    SELECT (timestamp / 3600000) as hour_bucket, COUNT(*) as count
    FROM audit_logs ${whereSql}
    GROUP BY hour_bucket
    ORDER BY count DESC
    LIMIT 24
  `).all(...params);

  const peakHours = byHourRows.map(r => ({
    hour: new Date(r.hour_bucket * 3600000).getHours(),
    hourBucket: r.hour_bucket * 3600000,
    count: r.count
  }));

  const totalCount = prepare(
    `SELECT COUNT(*) as count FROM audit_logs ${whereSql}`
  ).get(...params);

  return {
    period: {
      startTime: startTime ? parseInt(startTime) : null,
      endTime: endTime ? parseInt(endTime) : null
    },
    totalOperations: totalCount ? totalCount.count : 0,
    byOperationType: byTypeRows.map(r => ({ type: r.operation_type, count: r.count })),
    byOperator: byOperatorRows.map(r => ({ operator: r.operator, count: r.count })),
    deniedOperations: deniedCount ? deniedCount.count : 0,
    peakHours
  };
}

function getTargetTrail(targetId) {
  const rows = prepare(`
    SELECT * FROM audit_logs
    WHERE target_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(targetId);

  return rows.map(parseLogRow);
}

function getAuditReport(startTime, endTime) {
  const where = [];
  const params = [];

  if (startTime) {
    where.push('timestamp >= ?');
    params.push(parseInt(startTime));
  }
  if (endTime) {
    where.push('timestamp <= ?');
    params.push(parseInt(endTime));
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const totalCount = prepare(
    `SELECT COUNT(*) as count FROM audit_logs ${whereSql}`
  ).get(...params);

  const deniedWhere = ['operation_type = ?'];
  const deniedParams = ['operation_denied'];
  if (startTime) { deniedWhere.push('timestamp >= ?'); deniedParams.push(parseInt(startTime)); }
  if (endTime) { deniedWhere.push('timestamp <= ?'); deniedParams.push(parseInt(endTime)); }
  const deniedSql = 'WHERE ' + deniedWhere.join(' AND ');
  const deniedResult = prepare(`SELECT * FROM audit_logs ${deniedSql} ORDER BY timestamp DESC LIMIT 100`)
    .all(...deniedParams);

  const allRows = prepare(`SELECT * FROM audit_logs ${whereSql}`).all(...params);
  const offHours = [];
  for (const row of allRows) {
    const hour = new Date(row.timestamp).getHours();
    if (hour < WORK_START_HOUR || hour >= WORK_END_HOUR) {
      offHours.push(parseLogRow(row));
    }
  }

  const gateAdjustWhere = ['operation_type = ?'];
  const gateAdjustParams = ['gate_adjust'];
  if (startTime) { gateAdjustWhere.push('timestamp >= ?'); gateAdjustParams.push(parseInt(startTime)); }
  if (endTime) { gateAdjustWhere.push('timestamp <= ?'); gateAdjustParams.push(parseInt(endTime)); }
  const gateAdjustSql = 'WHERE ' + gateAdjustWhere.join(' AND ');
  const gateFreqRows = prepare(`
    SELECT target_id, COUNT(*) as count FROM audit_logs
    ${gateAdjustSql}
    GROUP BY target_id
    ORDER BY count DESC
  `).all(...gateAdjustParams);

  const gateFrequency = gateFreqRows.map(r => ({
    gateId: r.target_id,
    adjustmentCount: r.count
  }));

  const heatmap = buildHeatmap(allRows);

  return {
    generatedAt: Date.now(),
    period: {
      startTime: startTime ? parseInt(startTime) : null,
      endTime: endTime ? parseInt(endTime) : null,
      workHours: `${WORK_START_HOUR}:00 - ${WORK_END_HOUR}:00`
    },
    summary: {
      totalOperations: totalCount ? totalCount.count : 0,
      deniedOperations: deniedResult.length,
      offHoursOperations: offHours.length,
      abnormalOperations: deniedResult.length + offHours.length
    },
    abnormalOperations: {
      denied: deniedResult.map(parseLogRow),
      offHours: offHours.slice(0, 100)
    },
    gateAdjustmentFrequency: gateFrequency,
    heatmap: heatmap
  };
}

function buildHeatmap(rows) {
  const heatmap = {};
  for (let day = 0; day < 7; day++) {
    heatmap[day] = {};
    for (let hour = 0; hour < 24; hour++) {
      heatmap[day][hour] = 0;
    }
  }

  for (const row of rows) {
    const date = new Date(row.timestamp);
    const dayOfWeek = date.getDay();
    const hour = date.getHours();
    if (heatmap[dayOfWeek] && heatmap[dayOfWeek][hour] !== undefined) {
      heatmap[dayOfWeek][hour]++;
    }
  }

  const result = [];
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      result.push({
        day: day,
        dayName: dayNames[day],
        hour: hour,
        count: heatmap[day][hour]
      });
    }
  }
  return result;
}

module.exports = {
  VALID_OPERATION_TYPES,
  writeAuditLog,
  getLogById,
  queryLogs,
  getSummary,
  getTargetTrail,
  getAuditReport
};
