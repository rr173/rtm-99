const { prepare, saveDatabase } = require('../db');
const stateManager = require('./stateManager');
const { writeAuditLog } = require('./auditService');

const ALARM_THRESHOLDS = {
  turbidityMax: 50,
  doMin: 3,
  phMin: 6,
  phMax: 9
};

const WARNING_THRESHOLDS = {
  turbidityMax: 40,
  doMin: 4,
  phMin: 6.5,
  phMax: 8.5
};

const NORMAL_RECOVERY_COUNT = 3;

function evaluatePointStatus(turbidity, dissolvedOxygen, ph) {
  const alarmItems = [];
  const warningItems = [];

  if (turbidity > ALARM_THRESHOLDS.turbidityMax) {
    alarmItems.push('turbidity');
  } else if (turbidity > WARNING_THRESHOLDS.turbidityMax) {
    warningItems.push('turbidity');
  }

  if (dissolvedOxygen < ALARM_THRESHOLDS.doMin) {
    alarmItems.push('dissolved_oxygen');
  } else if (dissolvedOxygen < WARNING_THRESHOLDS.doMin) {
    warningItems.push('dissolved_oxygen');
  }

  if (ph < ALARM_THRESHOLDS.phMin || ph > ALARM_THRESHOLDS.phMax) {
    alarmItems.push('ph');
  } else if (ph < WARNING_THRESHOLDS.phMin || ph > WARNING_THRESHOLDS.phMax) {
    warningItems.push('ph');
  }

  let status = 'normal';
  if (alarmItems.length > 0) {
    status = 'alarm';
  } else if (warningItems.length > 0) {
    status = 'warning';
  }

  return {
    status,
    alarmItems,
    warningItems
  };
}

function getWorstStatus(statuses) {
  if (statuses.includes('alarm')) return 'alarm';
  if (statuses.includes('warning')) return 'warning';
  return 'normal';
}

function mergeItems(itemsList) {
  const merged = new Set();
  for (const items of itemsList) {
    for (const item of items) {
      merged.add(item);
    }
  }
  return Array.from(merged);
}

function getDownstreamDiversionGates(segmentId) {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const segIndex = segments.findIndex(s => s.id === segmentId);
  if (segIndex === -1) return [];

  const result = [];
  for (let i = segIndex; i < segments.length; i++) {
    const gates = prepare(
      `SELECT * FROM gates WHERE canal_segment_id = ? AND type = 'diversion'`
    ).all(segments[i].id);
    for (const g of gates) result.push(g);
  }
  return result;
}

function applyGateLockdown(segmentId, eventId, gate, operator = 'system') {
  const activeLockdown = prepare(
    `SELECT * FROM water_quality_lockdowns WHERE gate_id = ? AND status = 'active'`
  ).get(gate.id);
  if (activeLockdown) {
    return null;
  }

  const originalOpening = gate.current_opening;
  const restrictedOpening = originalOpening / 2;

  const finalOpening = stateManager.applyWaterQualityRestriction(gate.id, restrictedOpening, originalOpening);

  const lockdownResult = prepare(`
    INSERT INTO water_quality_lockdowns
    (segment_id, gate_id, event_id, original_opening, restricted_opening, status, applied_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(segmentId, gate.id, eventId || null, originalOpening, restrictedOpening, Date.now());

  const beforeState = { gateId: gate.id, opening: originalOpening };
  const afterState = { gateId: gate.id, opening: finalOpening, restrictedOpening };

  writeAuditLog({
    operationType: 'water_quality_lockdown_apply',
    operator,
    targetId: gate.id,
    beforeState,
    afterState,
    requestBody: {
      segmentId,
      eventId,
      reason: 'water_quality_alarm',
      originalOpening,
      restrictedOpening,
      finalOpening
    },
    responseStatus: 200,
    responseBody: { success: true, lockdownId: lockdownResult.lastInsertRowid }
  });

  saveDatabase();

  return {
    id: lockdownResult.lastInsertRowid,
    gateId: gate.id,
    gateName: gate.name,
    originalOpening,
    restrictedOpening,
    finalOpening
  };
}

function releaseGateLockdown(lockdownId, reason, operator = 'system') {
  const lockdown = prepare(
    `SELECT * FROM water_quality_lockdowns WHERE id = ? AND status = 'active'`
  ).get(parseInt(lockdownId));
  if (!lockdown) return null;

  const gate = prepare('SELECT * FROM gates WHERE id = ?').get(lockdown.gate_id);
  if (!gate) return null;

  const beforeOpening = gate.current_opening;

  const finalOpening = stateManager.removeWaterQualityRestriction(lockdown.gate_id, lockdown.original_opening);

  prepare(`
    UPDATE water_quality_lockdowns
    SET status = 'released', released_at = ?, release_reason = ?
    WHERE id = ?
  `).run(Date.now(), reason, parseInt(lockdownId));

  const beforeState = { gateId: lockdown.gate_id, opening: beforeOpening };
  const afterState = { gateId: lockdown.gate_id, opening: finalOpening, originalOpening: lockdown.original_opening };

  writeAuditLog({
    operationType: 'water_quality_lockdown_release',
    operator,
    targetId: lockdown.gate_id,
    beforeState,
    afterState,
    requestBody: {
      lockdownId,
      reason,
      previousRestrictedOpening: lockdown.restricted_opening,
      restoredOpening: lockdown.original_opening,
      finalOpening
    },
    responseStatus: 200,
    responseBody: { success: true }
  });

  saveDatabase();

  return {
    id: lockdownId,
    gateId: lockdown.gate_id,
    previousRestrictedOpening: lockdown.restricted_opening,
    restoredOpening: lockdown.original_opening,
    finalOpening
  };
}

function updateActiveEvent(segmentId, segmentStatus, ts, turbidity, doLevel, ph, alarmItems, warningItems) {
  const activeEvent = prepare(
    `SELECT * FROM water_quality_events WHERE segment_id = ? AND status = 'active' ORDER BY start_time DESC LIMIT 1`
  ).get(segmentId);

  let currentEventId = null;

  if (segmentStatus === 'normal') {
    if (activeEvent) {
      const durationSeconds = Math.max(0, Math.floor((ts - activeEvent.start_time) / 1000));
      prepare(`
        UPDATE water_quality_events
        SET end_time = ?, status = 'resolved', resolved_at = ?, duration_seconds = ?
        WHERE id = ?
      `).run(ts, ts, durationSeconds, activeEvent.id);
      saveDatabase();

      const activeLockdowns = prepare(
        `SELECT * FROM water_quality_lockdowns WHERE segment_id = ? AND status = 'active'`
      ).all(segmentId);
      for (const ld of activeLockdowns) {
        releaseGateLockdown(ld.id, 'water_quality_restored_normal');
      }
    }
    return { eventId: null, lockdownsApplied: [] };
  }

  if (!activeEvent) {
    const ins = prepare(`
      INSERT INTO water_quality_events
      (segment_id, event_type, start_time, peak_turbidity, peak_do, peak_ph,
       peak_warning_items, peak_alarm_items, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      segmentId,
      segmentStatus === 'alarm' ? 'alarm' : 'warning',
      ts,
      turbidity,
      doLevel,
      ph,
      JSON.stringify(warningItems),
      JSON.stringify(alarmItems)
    );
    currentEventId = ins.lastInsertRowid;
  } else {
    currentEventId = activeEvent.id;
    const prevPeakTurb = activeEvent.peak_turbidity ?? -Infinity;
    const prevPeakDo = activeEvent.peak_do ?? Infinity;
    const prevPeakPh = activeEvent.peak_ph ?? 7;

    const peakTurbidity = Math.max(prevPeakTurb, turbidity);
    const peakDo = Math.min(prevPeakDo, doLevel);
    let peakPh = prevPeakPh;
    if (Math.abs(ph - 7) > Math.abs(prevPeakPh - 7)) {
      peakPh = ph;
    }

    const prevAlarm = activeEvent.peak_alarm_items ? JSON.parse(activeEvent.peak_alarm_items) : [];
    const prevWarning = activeEvent.peak_warning_items ? JSON.parse(activeEvent.peak_warning_items) : [];

    const mergedAlarm = mergeItems([prevAlarm, alarmItems]);
    const mergedWarning = mergeItems([prevWarning, warningItems]);

    const eventType = segmentStatus === 'alarm' ? 'alarm' : activeEvent.event_type;

    prepare(`
      UPDATE water_quality_events
      SET event_type = ?, peak_turbidity = ?, peak_do = ?, peak_ph = ?,
          peak_alarm_items = ?, peak_warning_items = ?
      WHERE id = ?
    `).run(
      eventType,
      peakTurbidity,
      peakDo,
      peakPh,
      JSON.stringify(mergedAlarm),
      JSON.stringify(mergedWarning),
      activeEvent.id
    );
  }

  const lockdownsApplied = [];
  if (segmentStatus === 'alarm') {
    const downstreamGates = getDownstreamDiversionGates(segmentId);
    for (const gate of downstreamGates) {
      const result = applyGateLockdown(segmentId, currentEventId, gate);
      if (result) {
        lockdownsApplied.push(result);
      }
    }
    if (lockdownsApplied.length > 0 && activeEvent) {
      const actions = activeEvent.lockdown_actions ? JSON.parse(activeEvent.lockdown_actions) : [];
      for (const la of lockdownsApplied) {
        actions.push({
          lockdownId: la.id,
          gateId: la.gateId,
          gateName: la.gateName,
          originalOpening: la.originalOpening,
          restrictedOpening: la.restrictedOpening,
          finalOpening: la.finalOpening,
          timestamp: Date.now()
        });
      }
      prepare(`UPDATE water_quality_events SET lockdown_actions = ? WHERE id = ?`)
        .run(JSON.stringify(actions), activeEvent ? activeEvent.id : currentEventId);
      saveDatabase();
    } else if (lockdownsApplied.length > 0) {
      const actions = lockdownsApplied.map(la => ({
        lockdownId: la.id,
        gateId: la.gateId,
        gateName: la.gateName,
        originalOpening: la.originalOpening,
        restrictedOpening: la.restrictedOpening,
        finalOpening: la.finalOpening,
        timestamp: Date.now()
      }));
      prepare(`UPDATE water_quality_events SET lockdown_actions = ? WHERE id = ?`)
        .run(JSON.stringify(actions), currentEventId);
      saveDatabase();
    }
  }

  return {
    eventId: currentEventId,
    lockdownsApplied
  };
}

function reportWaterQuality(pointId, turbidity, dissolvedOxygen, ph, timestamp) {
  if (!pointId) return { error: '缺少测点ID (pointId)' };
  if (typeof turbidity !== 'number' || turbidity < 0) {
    return { error: '浊度必须是非负数字 (turbidity, 单位NTU)' };
  }
  if (typeof dissolvedOxygen !== 'number' || dissolvedOxygen < 0) {
    return { error: '溶解氧必须是非负数字 (dissolvedOxygen, 单位mg/L)' };
  }
  if (typeof ph !== 'number' || ph < 0 || ph > 14) {
    return { error: 'pH必须是0-14之间的数字' };
  }

  const point = prepare('SELECT * FROM measurement_points WHERE id = ?').get(pointId);
  if (!point) return { error: `测点不存在: ${pointId}` };

  const ts = timestamp || Date.now();
  const segmentId = point.canal_segment_id;

  const { status: pointStatus, alarmItems, warningItems } = evaluatePointStatus(
    turbidity, dissolvedOxygen, ph
  );

  prepare(`
    INSERT INTO water_quality_records
    (point_id, segment_id, turbidity, dissolved_oxygen, ph, status, warning_items, alarm_items, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pointId,
    segmentId,
    turbidity,
    dissolvedOxygen,
    ph,
    pointStatus,
    warningItems.length > 0 ? JSON.stringify(warningItems) : null,
    alarmItems.length > 0 ? JSON.stringify(alarmItems) : null,
    ts
  );

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  prepare(`DELETE FROM water_quality_records WHERE timestamp < ?`).run(cutoff);

  saveDatabase();

  const segmentResult = updateSegmentStatus(
    segmentId, pointId, ts, turbidity, dissolvedOxygen, ph, pointStatus, alarmItems, warningItems
  );

  return {
    success: true,
    pointId,
    segmentId,
    turbidity,
    dissolvedOxygen,
    ph,
    pointStatus,
    alarmItems,
    warningItems,
    timestamp: ts,
    segmentUpdate: segmentResult
  };
}

function updateSegmentStatus(segmentId, pointId, ts, lastTurb, lastDo, lastPh, pointStatus, pointAlarm, pointWarning) {
  let segStatus = prepare('SELECT * FROM water_quality_segment_status WHERE segment_id = ?').get(segmentId);
  if (!segStatus) {
    prepare(`
      INSERT INTO water_quality_segment_status
      (segment_id, status, peak_turbidity, peak_do, peak_ph, warning_items, alarm_items, last_updated, consecutive_normal_count, consecutive_alarm_count)
      VALUES (?, 'normal', ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(segmentId, lastTurb, lastDo, lastPh, null, null, ts);
    segStatus = prepare('SELECT * FROM water_quality_segment_status WHERE segment_id = ?').get(segmentId);
  }

  const recentRecords = prepare(`
    SELECT * FROM (
      SELECT * FROM water_quality_records
      WHERE segment_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    ) ORDER BY timestamp ASC
  `).all(segmentId);

  const pointLatestMap = {};
  for (const rec of recentRecords) {
    if (!pointLatestMap[rec.point_id] || rec.timestamp > pointLatestMap[rec.point_id].timestamp) {
      pointLatestMap[rec.point_id] = rec;
    }
  }

  const pointStatuses = [];
  const allAlarmItems = [];
  const allWarningItems = [];
  let worstTurb = -Infinity;
  let worstDo = Infinity;
  let worstPh = 7;

  for (const [pid, rec] of Object.entries(pointLatestMap)) {
    const ps = evaluatePointStatus(rec.turbidity, rec.dissolved_oxygen, rec.ph);
    pointStatuses.push(ps.status);
    if (ps.alarmItems.length > 0) allAlarmItems.push(ps.alarmItems);
    if (ps.warningItems.length > 0) allWarningItems.push(ps.warningItems);
    worstTurb = Math.max(worstTurb, rec.turbidity);
    worstDo = Math.min(worstDo, rec.dissolved_oxygen);
    if (Math.abs(rec.ph - 7) > Math.abs(worstPh - 7)) worstPh = rec.ph;
  }

  if (pointLatestMap[pointId]) {
    const currentPs = evaluatePointStatus(lastTurb, lastDo, lastPh);
    pointStatuses.push(currentPs.status);
    if (currentPs.alarmItems.length > 0) allAlarmItems.push(currentPs.alarmItems);
    if (currentPs.warningItems.length > 0) allWarningItems.push(currentPs.warningItems);
    worstTurb = Math.max(worstTurb, lastTurb);
    worstDo = Math.min(worstDo, lastDo);
    if (Math.abs(lastPh - 7) > Math.abs(worstPh - 7)) worstPh = lastPh;
  }

  const newStatus = getWorstStatus(pointStatuses.length > 0 ? pointStatuses : [pointStatus]);
  const mergedAlarm = mergeItems(allAlarmItems);
  const mergedWarning = mergeItems(allWarningItems);

  let consecutiveNormal = segStatus.consecutive_normal_count || 0;
  let consecutiveAlarm = segStatus.consecutive_alarm_count || 0;
  let firstAlarmAt = segStatus.first_alarm_at;

  if (newStatus === 'normal') {
    consecutiveNormal = consecutiveNormal + 1;
    consecutiveAlarm = 0;
  } else if (newStatus === 'alarm') {
    consecutiveAlarm = consecutiveAlarm + 1;
    consecutiveNormal = 0;
    if (!firstAlarmAt) firstAlarmAt = ts;
  } else {
    consecutiveNormal = 0;
    consecutiveAlarm = 0;
  }

  if (segStatus.status === 'alarm' && newStatus === 'normal') {
    if (consecutiveNormal < NORMAL_RECOVERY_COUNT) {
      prepare(`
        UPDATE water_quality_segment_status
        SET last_updated = ?, consecutive_normal_count = ?, consecutive_alarm_count = ?
        WHERE segment_id = ?
      `).run(ts, consecutiveNormal, consecutiveAlarm, segmentId);
      saveDatabase();

      return {
        previousStatus: segStatus.status,
        currentStatus: segStatus.status,
        recovering: true,
        consecutiveNormalCount: consecutiveNormal,
        requiredRecoveryCount: NORMAL_RECOVERY_COUNT,
        eventUpdate: null
      };
    }
  }

  if (segStatus.status !== newStatus || mergedAlarm.length > 0 || mergedWarning.length > 0) {
    prepare(`
      UPDATE water_quality_segment_status
      SET status = ?, peak_turbidity = ?, peak_do = ?, peak_ph = ?,
          warning_items = ?, alarm_items = ?, first_alarm_at = ?, last_updated = ?,
          consecutive_normal_count = ?, consecutive_alarm_count = ?
      WHERE segment_id = ?
    `).run(
      newStatus,
      worstTurb === -Infinity ? null : worstTurb,
      worstDo === Infinity ? null : worstDo,
      Math.abs(worstPh - 7) > 0 ? worstPh : null,
      mergedWarning.length > 0 ? JSON.stringify(mergedWarning) : null,
      mergedAlarm.length > 0 ? JSON.stringify(mergedAlarm) : null,
      newStatus === 'normal' ? null : firstAlarmAt,
      ts,
      consecutiveNormal,
      consecutiveAlarm,
      segmentId
    );
    saveDatabase();
  }

  const eventUpdate = updateActiveEvent(
    segmentId, newStatus, ts,
    worstTurb === -Infinity ? lastTurb : worstTurb,
    worstDo === Infinity ? lastDo : worstDo,
    worstPh === 7 ? lastPh : worstPh,
    mergedAlarm,
    mergedWarning
  );

  return {
    previousStatus: segStatus.status,
    currentStatus: newStatus,
    peakTurbidity: worstTurb === -Infinity ? lastTurb : worstTurb,
    peakDo: worstDo === Infinity ? lastDo : worstDo,
    peakPh: worstPh === 7 ? lastPh : worstPh,
    segmentAlarmItems: mergedAlarm,
    segmentWarningItems: mergedWarning,
    consecutiveNormalCount: consecutiveNormal,
    consecutiveAlarmCount: consecutiveAlarm,
    eventUpdate
  };
}

function getAllSegmentStatus() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const result = [];

  for (const seg of segments) {
    let status = prepare('SELECT * FROM water_quality_segment_status WHERE segment_id = ?').get(seg.id);
    if (!status) {
      status = {
        segment_id: seg.id,
        status: 'normal',
        peak_turbidity: null,
        peak_do: null,
        peak_ph: null,
        warning_items: null,
        alarm_items: null,
        first_alarm_at: null,
        last_updated: null,
        consecutive_normal_count: 0,
        consecutive_alarm_count: 0
      };
    }
    result.push({
      segmentId: seg.id,
      segmentName: seg.name,
      status: status.status,
      peakTurbidity: status.peak_turbidity,
      peakDissolvedOxygen: status.peak_do,
      peakPh: status.peak_ph,
      warningItems: status.warning_items ? JSON.parse(status.warning_items) : [],
      alarmItems: status.alarm_items ? JSON.parse(status.alarm_items) : [],
      firstAlarmAt: status.first_alarm_at,
      lastUpdated: status.last_updated,
      consecutiveAlarmCount: status.consecutive_alarm_count || 0,
      consecutiveNormalCount: status.consecutive_normal_count || 0
    });
  }

  return result;
}

function getSegmentStatusDetail(segmentId) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) return { error: '渠段不存在' };

  let status = prepare('SELECT * FROM water_quality_segment_status WHERE segment_id = ?').get(segmentId);
  if (!status) {
    status = {
      segment_id: seg.id,
      status: 'normal',
      peak_turbidity: null,
      peak_do: null,
      peak_ph: null,
      warning_items: null,
      alarm_items: null,
      first_alarm_at: null,
      last_updated: null,
      consecutive_normal_count: 0,
      consecutive_alarm_count: 0
    };
  }

  const points = prepare(`
    SELECT * FROM measurement_points WHERE canal_segment_id = ?
    ORDER BY distance_from_upstream
  `).all(segmentId);

  const pointDetails = [];
  for (const point of points) {
    const latest = prepare(`
      SELECT * FROM water_quality_records
      WHERE point_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(point.id);

    let latestData = null;
    if (latest) {
      latestData = {
        turbidity: latest.turbidity,
        dissolvedOxygen: latest.dissolved_oxygen,
        ph: latest.ph,
        status: latest.status,
        alarmItems: latest.alarm_items ? JSON.parse(latest.alarm_items) : [],
        warningItems: latest.warning_items ? JSON.parse(latest.warning_items) : [],
        timestamp: latest.timestamp
      };
    }

    const alarmRecords = prepare(`
      SELECT * FROM water_quality_records
      WHERE point_id = ? AND status = 'alarm'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(point.id);

    let consecutiveAlarmDuration = null;
    if (alarmRecords && latest && latest.status === 'alarm') {
      consecutiveAlarmDuration = Date.now() - alarmRecords.timestamp;
    }

    pointDetails.push({
      pointId: point.id,
      pointName: point.name,
      distanceFromUpstream: point.distance_from_upstream,
      latest: latestData,
      consecutiveAlarmDurationMs: consecutiveAlarmDuration
    });
  }

  const activeLockdowns = prepare(`
    SELECT wq.*, g.name as gate_name, g.current_opening as current_opening, g.max_opening as max_opening
    FROM water_quality_lockdowns wq
    JOIN gates g ON wq.gate_id = g.id
    WHERE wq.segment_id = ? AND wq.status = 'active'
  `).all(segmentId);

  const activeEvent = prepare(`
    SELECT * FROM water_quality_events
    WHERE segment_id = ? AND status = 'active'
    ORDER BY start_time DESC
    LIMIT 1
  `).get(segmentId);

  return {
    segmentId: seg.id,
    segmentName: seg.name,
    status: status.status,
    peakTurbidity: status.peak_turbidity,
    peakDissolvedOxygen: status.peak_do,
    peakPh: status.peak_ph,
    warningItems: status.warning_items ? JSON.parse(status.warning_items) : [],
    alarmItems: status.alarm_items ? JSON.parse(status.alarm_items) : [],
    firstAlarmAt: status.first_alarm_at,
    lastUpdated: status.last_updated,
    consecutiveAlarmCount: status.consecutive_alarm_count || 0,
    consecutiveNormalCount: status.consecutive_normal_count || 0,
    points: pointDetails,
    activeLockdowns: activeLockdowns.map(ld => ({
      id: ld.id,
      gateId: ld.gate_id,
      gateName: ld.gate_name,
      originalOpening: ld.original_opening,
      restrictedOpening: ld.restricted_opening,
      currentOpening: ld.current_opening,
      maxOpening: ld.max_opening,
      appliedAt: ld.applied_at
    })),
    activeEvent: activeEvent ? {
      id: activeEvent.id,
      eventType: activeEvent.event_type,
      startTime: activeEvent.start_time,
      peakTurbidity: activeEvent.peak_turbidity,
      peakDo: activeEvent.peak_do,
      peakPh: activeEvent.peak_ph,
      alarmItems: activeEvent.peak_alarm_items ? JSON.parse(activeEvent.peak_alarm_items) : [],
      warningItems: activeEvent.peak_warning_items ? JSON.parse(activeEvent.peak_warning_items) : [],
      lockdownActions: activeEvent.lockdown_actions ? JSON.parse(activeEvent.lockdown_actions) : []
    } : null,
    thresholds: {
      alarm: ALARM_THRESHOLDS,
      warning: WARNING_THRESHOLDS
    }
  };
}

function getActiveLockdowns() {
  const rows = prepare(`
    SELECT wq.*, g.name as gate_name, g.current_opening as current_opening,
           g.max_opening as max_opening, g.canal_segment_id as gate_segment_id,
           cs.name as segment_name
    FROM water_quality_lockdowns wq
    JOIN gates g ON wq.gate_id = g.id
    LEFT JOIN canal_segments cs ON wq.segment_id = cs.id
    WHERE wq.status = 'active'
    ORDER BY wq.applied_at DESC
  `).all();

  return rows.map(ld => ({
    id: ld.id,
    segmentId: ld.segment_id,
    segmentName: ld.segment_name,
    gateId: ld.gate_id,
    gateName: ld.gate_name,
    gateSegmentId: ld.gate_segment_id,
    originalOpening: ld.original_opening,
    restrictedOpening: ld.restricted_opening,
    currentOpening: ld.current_opening,
    maxOpening: ld.max_opening,
    appliedAt: ld.applied_at,
    durationMs: Date.now() - ld.applied_at
  }));
}

function getEventList(filters = {}) {
  const { segmentId, startTime, endTime, status } = filters;
  const where = [];
  const params = [];

  if (segmentId) {
    where.push('e.segment_id = ?');
    params.push(segmentId);
  }
  if (startTime) {
    where.push('e.start_time >= ?');
    params.push(parseInt(startTime));
  }
  if (endTime) {
    where.push('(e.end_time IS NULL OR e.end_time <= ?)');
    params.push(parseInt(endTime));
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const rows = prepare(`
    SELECT e.*, cs.name as segment_name
    FROM water_quality_events e
    LEFT JOIN canal_segments cs ON e.segment_id = cs.id
    ${whereSql}
    ORDER BY e.start_time DESC
  `).all(...params);

  const events = rows.map(row => ({
    id: row.id,
    segmentId: row.segment_id,
    segmentName: row.segment_name,
    eventType: row.event_type,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.end_time ? row.end_time - row.start_time : Date.now() - row.start_time,
    peakTurbidity: row.peak_turbidity,
    peakDo: row.peak_do,
    peakPh: row.peak_ph,
    alarmItems: row.peak_alarm_items ? JSON.parse(row.peak_alarm_items) : [],
    warningItems: row.peak_warning_items ? JSON.parse(row.peak_warning_items) : [],
    lockdownActions: row.lockdown_actions ? JSON.parse(row.lockdown_actions) : [],
    resolvedAt: row.resolved_at
  }));

  return {
    queryTime: Date.now(),
    total: events.length,
    events
  };
}

function getEventDetail(id) {
  const row = prepare(`
    SELECT e.*, cs.name as segment_name
    FROM water_quality_events e
    LEFT JOIN canal_segments cs ON e.segment_id = cs.id
    WHERE e.id = ?
  `).get(parseInt(id));

  if (!row) return { error: '事件不存在' };

  const timeline = prepare(`
    SELECT * FROM water_quality_records
    WHERE segment_id = ? AND timestamp >= ?
    ${row.end_time ? 'AND timestamp <= ?' : ''}
    ORDER BY timestamp ASC
  `).all(row.segment_id, row.start_time, ...(row.end_time ? [row.end_time] : []));

  const lockdowns = prepare(`
    SELECT wq.*, g.name as gate_name
    FROM water_quality_lockdowns wq
    JOIN gates g ON wq.gate_id = g.id
    WHERE wq.event_id = ?
    ORDER BY wq.applied_at ASC
  `).all(parseInt(id));

  return {
    id: row.id,
    segmentId: row.segment_id,
    segmentName: row.segment_name,
    eventType: row.event_type,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    resolvedAt: row.resolved_at,
    durationSeconds: row.end_time
      ? Math.floor((row.end_time - row.start_time) / 1000)
      : Math.floor((Date.now() - row.start_time) / 1000),
    peakTurbidity: row.peak_turbidity,
    peakDo: row.peak_do,
    peakPh: row.peak_ph,
    alarmItems: row.peak_alarm_items ? JSON.parse(row.peak_alarm_items) : [],
    warningItems: row.peak_warning_items ? JSON.parse(row.peak_warning_items) : [],
    lockdownActions: row.lockdown_actions ? JSON.parse(row.lockdown_actions) : [],
    lockdowns: lockdowns.map(ld => ({
      id: ld.id,
      gateId: ld.gate_id,
      gateName: ld.gate_name,
      originalOpening: ld.original_opening,
      restrictedOpening: ld.restricted_opening,
      status: ld.status,
      appliedAt: ld.applied_at,
      releasedAt: ld.released_at,
      releaseReason: ld.release_reason
    })),
    timeline: timeline.map(t => ({
      id: t.id,
      pointId: t.point_id,
      turbidity: t.turbidity,
      dissolvedOxygen: t.dissolved_oxygen,
      ph: t.ph,
      status: t.status,
      alarmItems: t.alarm_items ? JSON.parse(t.alarm_items) : [],
      warningItems: t.warning_items ? JSON.parse(t.warning_items) : [],
      timestamp: t.timestamp
    }))
  };
}

function initWaterQualityDemoData() {
  const existing = prepare('SELECT 1 FROM system_state WHERE key = ?').get('water_quality_demo_initialized');
  if (existing) return;

  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const points = prepare('SELECT * FROM measurement_points ORDER BY distance_from_upstream').all();
  if (segments.length === 0) return;

  const now = Date.now();

  const segSetup = {
    'seg1': { turbidity: 20, do: 7.2, ph: 7.2, status: 'normal' },
    'seg2': { turbidity: 18, do: 7.5, ph: 7.1, status: 'normal' },
    'seg3': { turbidity: 22, do: 6.8, ph: 7.3, status: 'normal' },
    'seg4': { turbidity: 15, do: 7.8, ph: 7.0, status: 'normal' },
    'seg5': { turbidity: 55, do: 4.5, ph: 7.2, status: 'alarm' }
  };

  for (const seg of segments) {
    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    if (segPoints.length === 0) continue;

    const setup = segSetup[seg.id] || { turbidity: 20, do: 7.0, ph: 7.2, status: 'normal' };

    for (let i = 0; i < 5; i++) {
      const ts = now - (5 - i) * 10 * 60 * 1000;
      for (const pt of segPoints) {
        const turbNoise = (Math.random() - 0.5) * 2;
        const doNoise = (Math.random() - 0.5) * 0.3;
        const phNoise = (Math.random() - 0.5) * 0.1;

        let turb = setup.turbidity + turbNoise;
        let doLevel = setup.do + doNoise;
        let ph = setup.ph + phNoise;

        turb = Math.max(0, turb);
        doLevel = Math.max(0, doLevel);
        ph = Math.max(0, Math.min(14, ph));

        const ps = evaluatePointStatus(turb, doLevel, ph);
        prepare(`
          INSERT INTO water_quality_records
          (point_id, segment_id, turbidity, dissolved_oxygen, ph, status, warning_items, alarm_items, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pt.id,
          seg.id,
          turb,
          doLevel,
          ph,
          ps.status,
          ps.warningItems.length > 0 ? JSON.stringify(ps.warningItems) : null,
          ps.alarmItems.length > 0 ? JSON.stringify(ps.alarmItems) : null,
          ts
        );
      }
    }

    const { status: segStatus, alarmItems, warningItems } = evaluatePointStatus(
      setup.turbidity, setup.do, setup.ph
    );

    const isAlarm = segStatus === 'alarm';
    prepare(`
      INSERT OR REPLACE INTO water_quality_segment_status
      (segment_id, status, peak_turbidity, peak_do, peak_ph, warning_items, alarm_items,
       first_alarm_at, last_updated, consecutive_normal_count, consecutive_alarm_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seg.id,
      segStatus,
      setup.turbidity,
      setup.do,
      setup.ph,
      warningItems.length > 0 ? JSON.stringify(warningItems) : null,
      alarmItems.length > 0 ? JSON.stringify(alarmItems) : null,
      isAlarm ? now - 30 * 60 * 1000 : null,
      now,
      segStatus === 'normal' ? 3 : 0,
      isAlarm ? 5 : 0
    );

    if (isAlarm) {
      const eventInsert = prepare(`
        INSERT INTO water_quality_events
        (segment_id, event_type, start_time, peak_turbidity, peak_do, peak_ph,
         peak_warning_items, peak_alarm_items, status)
        VALUES (?, 'alarm', ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        seg.id,
        now - 30 * 60 * 1000,
        setup.turbidity,
        setup.do,
        setup.ph,
        warningItems.length > 0 ? JSON.stringify(warningItems) : null,
        alarmItems.length > 0 ? JSON.stringify(alarmItems) : null
      );

      const downstreamGates = getDownstreamDiversionGates(seg.id);
      const lockdownActions = [];
      for (const gate of downstreamGates) {
        const originalOpening = gate.current_opening;
        const restrictedOpening = originalOpening / 2;

        const finalOpening = stateManager.applyWaterQualityRestriction(
          gate.id, restrictedOpening, originalOpening
        );

        const ldInsert = prepare(`
          INSERT INTO water_quality_lockdowns
          (segment_id, gate_id, event_id, original_opening, restricted_opening, status, applied_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
        `).run(seg.id, gate.id, eventInsert.lastInsertRowid, originalOpening, restrictedOpening, now - 25 * 60 * 1000);

        lockdownActions.push({
          lockdownId: ldInsert.lastInsertRowid,
          gateId: gate.id,
          gateName: gate.name,
          originalOpening,
          restrictedOpening,
          finalOpening,
          timestamp: now - 25 * 60 * 1000
        });
      }

      if (lockdownActions.length > 0) {
        prepare(`UPDATE water_quality_events SET lockdown_actions = ? WHERE id = ?`)
          .run(JSON.stringify(lockdownActions), eventInsert.lastInsertRowid);
      }
    }
  }

  prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('water_quality_demo_initialized', 'true');
  saveDatabase();
  console.log('水质监测演示数据初始化完成: seg1-seg4正常, seg5超标(浊度55NTU)');
}

module.exports = {
  reportWaterQuality,
  getAllSegmentStatus,
  getSegmentStatusDetail,
  getActiveLockdowns,
  getEventList,
  getEventDetail,
  evaluatePointStatus,
  initWaterQualityDemoData,
  ALARM_THRESHOLDS,
  WARNING_THRESHOLDS,
  NORMAL_RECOVERY_COUNT
};
