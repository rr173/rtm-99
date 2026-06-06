const { prepare, saveDatabase } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');
const stateManager = require('./stateManager');
const siltationService = require('./siltationService');

const ICE_THICKNESS_COEFF = 0.015;
const MIN_FLOW_VELOCITY = 0.5;

function getPointUpstreamSegment(pointId) {
  const point = prepare('SELECT * FROM measurement_points WHERE id = ?').get(pointId);
  if (!point) return null;
  return point.canal_segment_id;
}

function recordTemperature(pointId, airTemp, waterTemp, timestamp) {
  if (!pointId) return { error: '缺少测点ID' };
  if (typeof airTemp !== 'number') return { error: '气温必须是数字' };
  if (typeof waterTemp !== 'number') return { error: '水温必须是数字' };

  const point = prepare('SELECT * FROM measurement_points WHERE id = ?').get(pointId);
  if (!point) return { error: '测点不存在' };

  const ts = timestamp || Date.now();

  prepare(`
    INSERT INTO ice_temperature_records (point_id, air_temperature, water_temperature, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(pointId, airTemp, waterTemp, ts);

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  prepare('DELETE FROM ice_temperature_records WHERE timestamp < ?').run(cutoff);

  saveDatabase();

  const segmentId = point.canal_segment_id;
  const statusResult = updateSegmentIceStatus(segmentId, pointId, airTemp, waterTemp, ts);

  return {
    success: true,
    pointId: pointId,
    segmentId: segmentId,
    airTemperature: airTemp,
    waterTemperature: waterTemp,
    timestamp: ts,
    statusUpdate: statusResult
  };
}

function getRecentRecords(pointId, limit = 10) {
  return prepare(`
    SELECT * FROM ice_temperature_records
    WHERE point_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(pointId, limit);
}

function updateSegmentIceStatus(segmentId, pointId, airTemp, waterTemp, timestamp) {
  let segStatus = prepare('SELECT * FROM ice_segment_status WHERE segment_id = ?').get(segmentId);
  const now = timestamp || Date.now();

  if (!segStatus) {
    prepare(`
      INSERT INTO ice_segment_status 
      (segment_id, status, ice_thickness, cumulative_negative_temp_hours, last_updated, consecutive_icing_count, consecutive_thaw_count)
      VALUES (?, 'normal', 0, 0, ?, 0, 0)
    `).run(segmentId, now);
    segStatus = prepare('SELECT * FROM ice_segment_status WHERE segment_id = ?').get(segmentId);
  }

  const recentRecords = getRecentRecords(pointId, 5);
  const recentForCheck = recentRecords.slice(0, 3).reverse();

  let consecutiveIcing = 0;
  let consecutiveThaw = 0;

  for (const rec of recentForCheck) {
    if (rec.water_temperature < 1 && rec.air_temperature < -3) {
      consecutiveIcing++;
    } else {
      break;
    }
  }

  for (const rec of recentForCheck) {
    if (rec.water_temperature > 3) {
      consecutiveThaw++;
    } else {
      break;
    }
  }

  let newStatus = segStatus.status;
  let frozenAt = segStatus.frozen_at;
  let cumulativeNegHours = segStatus.cumulative_negative_temp_hours || 0;

  if (segStatus.status === 'normal' || segStatus.status === 'warning') {
    if (consecutiveIcing >= 3) {
      newStatus = 'frozen';
      frozenAt = now;
      cumulativeNegHours = 0;
    } else if (waterTemp < 2) {
      newStatus = 'warning';
    } else {
      newStatus = 'normal';
    }
  } else if (segStatus.status === 'frozen') {
    if (consecutiveThaw >= 3) {
      newStatus = 'thawing';
    }
    if (airTemp < 0) {
      const lastRecord = recentRecords.length > 1 ? recentRecords[1] : null;
      let hoursIncrement = 1;
      if (lastRecord) {
        hoursIncrement = Math.max(0.01, (now - lastRecord.timestamp) / (1000 * 60 * 60));
      }
      cumulativeNegHours += Math.abs(airTemp) * hoursIncrement;
    }
  } else if (segStatus.status === 'thawing') {
    if (waterTemp > 3 && consecutiveThaw >= 3) {
      newStatus = 'normal';
      cumulativeNegHours = 0;
      frozenAt = null;
    } else if (waterTemp < 2) {
      newStatus = 'warning';
      cumulativeNegHours = 0;
      frozenAt = null;
    }
  }

  const iceThickness = newStatus === 'frozen' || newStatus === 'thawing'
    ? ICE_THICKNESS_COEFF * Math.sqrt(Math.max(0, cumulativeNegHours))
    : 0;

  prepare(`
    UPDATE ice_segment_status
    SET status = ?, ice_thickness = ?, cumulative_negative_temp_hours = ?, 
        frozen_at = ?, last_updated = ?, consecutive_icing_count = ?, consecutive_thaw_count = ?
    WHERE segment_id = ?
  `).run(
    newStatus,
    iceThickness,
    cumulativeNegHours,
    frozenAt,
    now,
    consecutiveIcing,
    consecutiveThaw,
    segmentId
  );

  saveDatabase();

  return {
    previousStatus: segStatus.status,
    currentStatus: newStatus,
    iceThickness: Math.round(iceThickness * 1000) / 1000,
    cumulativeNegativeTempHours: Math.round(cumulativeNegHours * 100) / 100
  };
}

function getAllSegmentStatus() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const result = [];

  for (const seg of segments) {
    let status = prepare('SELECT * FROM ice_segment_status WHERE segment_id = ?').get(seg.id);
    if (!status) {
      status = {
        segment_id: seg.id,
        status: 'normal',
        ice_thickness: 0,
        cumulative_negative_temp_hours: 0,
        frozen_at: null,
        last_updated: null
      };
    }
    result.push({
      segmentId: seg.id,
      segmentName: seg.name,
      status: status.status,
      iceThickness: Math.round((status.ice_thickness || 0) * 1000) / 1000,
      effectiveCrossSectionRatio: seg.design_water_level > 0
        ? Math.round(Math.max(0, 1 - (status.ice_thickness || 0) / seg.design_water_level) * 1000) / 1000
        : 1,
      manningMultiplier: status.status === 'frozen' ? 1.5 : 1.0,
      cumulativeNegativeTempHours: Math.round((status.cumulative_negative_temp_hours || 0) * 100) / 100,
      frozenAt: status.frozen_at,
      lastUpdated: status.last_updated
    });
  }

  return result;
}

function getSegmentStatusDetail(segmentId) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) return { error: '渠段不存在' };

  let status = prepare('SELECT * FROM ice_segment_status WHERE segment_id = ?').get(segmentId);
  if (!status) {
    status = {
      segment_id: seg.id,
      status: 'normal',
      ice_thickness: 0,
      cumulative_negative_temp_hours: 0,
      frozen_at: null,
      last_updated: null,
      consecutive_icing_count: 0,
      consecutive_thaw_count: 0
    };
  }

  const points = prepare(`
    SELECT * FROM measurement_points WHERE canal_segment_id = ?
    ORDER BY distance_from_upstream
  `).all(segmentId);

  const tempRecords = [];
  for (const point of points) {
    const records = getRecentRecords(point.id, 5);
    if (records.length > 0) {
      tempRecords.push({
        pointId: point.id,
        pointName: point.name,
        latest: records[0] ? {
          airTemperature: records[0].air_temperature,
          waterTemperature: records[0].water_temperature,
          timestamp: records[0].timestamp
        } : null,
        recent: records
      });
    }
  }

  const iceThickness = status.ice_thickness || 0;
  const effectiveDepthRatio = seg.design_water_level > 0
    ? Math.max(0, 1 - iceThickness / seg.design_water_level)
    : 1;

  return {
    segmentId: seg.id,
    segmentName: seg.name,
    status: status.status,
    designWaterLevel: seg.design_water_level,
    iceThickness: Math.round(iceThickness * 1000) / 1000,
    effectiveWaterDepth: Math.round(Math.max(0, seg.design_water_level - iceThickness) * 1000) / 1000,
    effectiveCrossSectionRatio: Math.round(effectiveDepthRatio * 1000) / 1000,
    manningMultiplier: status.status === 'frozen' ? 1.5 : 1.0,
    baseManningN: seg.manning_n,
    adjustedManningN: status.status === 'frozen' ? seg.manning_n * 1.5 : seg.manning_n,
    cumulativeNegativeTempHours: Math.round((status.cumulative_negative_temp_hours || 0) * 100) / 100,
    frozenAt: status.frozen_at,
    lastUpdated: status.last_updated,
    consecutiveIcingCount: status.consecutive_icing_count || 0,
    consecutiveThawCount: status.consecutive_thaw_count || 0,
    temperatureRecords: tempRecords
  };
}

function getHydraulicAdjustments() {
  const statuses = getAllSegmentStatus();
  return {
    calculationTime: Date.now(),
    adjustments: statuses.map(s => ({
      segmentId: s.segmentId,
      segmentName: s.segmentName,
      status: s.status,
      manningMultiplier: s.manningMultiplier,
      effectiveCrossSectionRatio: s.effectiveCrossSectionRatio,
      iceThickness: s.iceThickness
    }))
  };
}

function getSegmentIceAdjustment(segmentId) {
  let status = prepare('SELECT * FROM ice_segment_status WHERE segment_id = ?').get(segmentId);
  if (!status) {
    return {
      manningMultiplier: 1.0,
      iceThickness: 0,
      isFrozen: false
    };
  }
  return {
    manningMultiplier: status.status === 'frozen' ? 1.5 : 1.0,
    iceThickness: status.ice_thickness || 0,
    isFrozen: status.status === 'frozen'
  };
}

function applyIceAdjustmentsToSegments(segments) {
  return segments.map(seg => {
    const adj = getSegmentIceAdjustment(seg.id);
    return {
      ...seg,
      manning_n: seg.manning_n * adj.manningMultiplier,
      _iceThickness: adj.iceThickness,
      _originalManningN: seg.manning_n,
      _isFrozen: adj.isFrozen
    };
  });
}

function computeMinFlowForVelocity(seg, minVelocity = MIN_FLOW_VELOCITY) {
  const adj = getSegmentIceAdjustment(seg.id);
  const sd = seg.siltation_depth || 0;
  const iceThickness = adj.iceThickness;
  const effectiveDesignDepth = Math.max(0.1, seg.design_water_level - sd - iceThickness);

  const targetDepth = effectiveDesignDepth * 0.7;
  const A = hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, targetDepth);
  const minFlow = A * minVelocity;

  return {
    minFlow: Math.round(minFlow * 1000) / 1000,
    targetDepth: Math.round(targetDepth * 1000) / 1000,
    crossSectionArea: Math.round(A * 1000) / 1000,
    minVelocity: minVelocity
  };
}

function getRecommendations() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();
  const points = prepare('SELECT * FROM measurement_points').all();
  const statuses = getAllSegmentStatus();

  const statusMap = {};
  for (const s of statuses) statusMap[s.segmentId] = s;

  const frozenSegments = segments.filter(seg =>
    statusMap[seg.id] && (statusMap[seg.id].status === 'frozen' || statusMap[seg.id].status === 'warning')
  );

  const underConstructionIds = siltationService.getUnderConstructionSegmentIds();
  const segmentsForHydraulics = applyIceAdjustmentsToSegments(
    segments.map(seg => {
      if (underConstructionIds.includes(seg.id)) {
        return { ...seg, siltation_depth: seg.design_water_level };
      }
      return seg;
    })
  );

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

  const recommendations = [];

  for (const seg of frozenSegments) {
    const status = statusMap[seg.id];
    const ss = steadyState[seg.id];
    const minFlowInfo = computeMinFlowForVelocity(seg);
    const currentFlow = ss ? ss.flow : 0;
    const currentVelocity = ss && ss.effectiveDepth > 0
      ? currentFlow / hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, ss.effectiveDepth)
      : 0;

    const flowDeficit = Math.max(0, minFlowInfo.minFlow - currentFlow);
    const needsAdjustment = flowDeficit > 0.01;

    const segGates = gates.filter(g => g.canal_segment_id === seg.id ||
      (g.position_on_segment <= 0.01 && segments.findIndex(s => s.id === seg.id) > 0 &&
        segments[segments.findIndex(s => s.id === seg.id) - 1].id === g.canal_segment_id));

    const gateAdjustments = [];
    for (const gate of segGates) {
      if (gate.type === 'regulator' && gate.position_on_segment <= 0.01) {
        const currentOpening = gate.current_opening;
        const gateSs = steadyState[seg.id];
        const currentGateFlow = gateSs ? gateSs.flow : 0;
        let suggestedOpening = currentOpening;

        if (needsAdjustment && currentGateFlow > 0) {
          const ratio = Math.sqrt((currentGateFlow + flowDeficit) / currentGateFlow);
          suggestedOpening = Math.min(gate.max_opening, currentOpening * ratio);
        } else if (needsAdjustment) {
          suggestedOpening = Math.min(gate.max_opening, currentOpening * 1.2);
        }

        const direction = suggestedOpening > currentOpening ? 'increase' :
          suggestedOpening < currentOpening ? 'decrease' : 'maintain';

        if (direction !== 'maintain' || needsAdjustment) {
          gateAdjustments.push({
            gateId: gate.id,
            gateName: gate.name,
            currentOpening: currentOpening,
            suggestedOpening: Math.round(suggestedOpening * 1000) / 1000,
            adjustmentDirection: direction,
            adjustmentMagnitude: Math.round((suggestedOpening - currentOpening) * 1000) / 1000,
            adjustmentPercentage: Math.round(((suggestedOpening - currentOpening) / Math.max(0.001, currentOpening)) * 100)
          });
        }
      }
    }

    recommendations.push({
      segmentId: seg.id,
      segmentName: seg.name,
      iceStatus: status.status,
      iceThickness: status.iceThickness,
      manningMultiplier: status.manningMultiplier,
      effectiveCrossSectionRatio: status.effectiveCrossSectionRatio,
      currentFlow: Math.round(currentFlow * 1000) / 1000,
      currentVelocity: Math.round(currentVelocity * 1000) / 1000,
      requiredMinFlow: minFlowInfo.minFlow,
      requiredMinVelocity: minFlowInfo.minVelocity,
      flowDeficit: Math.round(flowDeficit * 1000) / 1000,
      needsAdjustment: needsAdjustment,
      recommendation: needsAdjustment
        ? `建议加大上游来水量,增加流速防止冰塞。流量缺口约 ${Math.round(flowDeficit * 1000) / 1000} m³/s`
        : '当前流量满足防冻流速要求',
      gateAdjustments: gateAdjustments
    });
  }

  return {
    generationTime: Date.now(),
    affectedSegments: frozenSegments.length,
    recommendations: recommendations,
    summary: {
      frozenCount: recommendations.filter(r => r.iceStatus === 'frozen').length,
      warningCount: recommendations.filter(r => r.iceStatus === 'warning').length,
      needAdjustmentCount: recommendations.filter(r => r.needsAdjustment).length
    }
  };
}

function applyRecommendations(operator = 'system') {
  const recResult = getRecommendations();
  const adjustments = [];
  const appliedGates = new Set();

  for (const rec of recResult.recommendations) {
    for (const ga of rec.gateAdjustments) {
      if (appliedGates.has(ga.gateId)) continue;
      if (stateManager.isGateLocked(ga.gateId)) continue;

      const gate = prepare('SELECT * FROM gates WHERE id = ?').get(ga.gateId);
      if (!gate) continue;

      const previousOpening = gate.current_opening;
      const newOpening = stateManager.updateGateOpening(ga.gateId, ga.suggestedOpening);

      adjustments.push({
        gateId: ga.gateId,
        gateName: ga.gateName,
        previousOpening: previousOpening,
        newOpening: newOpening,
        adjustmentDirection: ga.adjustmentDirection,
        adjustmentMagnitude: Math.round((newOpening - previousOpening) * 1000) / 1000
      });
      appliedGates.add(ga.gateId);
    }
  }

  const segmentIds = recResult.recommendations.map(r => r.segmentId).join(',');

  prepare(`
    INSERT INTO ice_dispatch_records (timestamp, operator, segment_ids, adjustments_json, recommendations_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    operator,
    segmentIds,
    JSON.stringify(adjustments),
    JSON.stringify(recResult.recommendations)
  );

  saveDatabase();

  return {
    success: true,
    appliedAt: Date.now(),
    operator: operator,
    adjustmentsApplied: adjustments.length,
    adjustments: adjustments,
    originalRecommendations: recResult
  };
}

function initIceDemoData() {
  const existing = prepare('SELECT 1 FROM system_state WHERE key = ?').get('ice_demo_initialized');
  if (existing) return;

  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  if (segments.length === 0) return;

  const now = Date.now();
  const points = prepare('SELECT * FROM measurement_points ORDER BY distance_from_upstream').all();

  const tempSetup = {
    'seg1': { air: 5, water: 8, records: 1 },
    'seg2': { air: 4, water: 8, records: 1 },
    'seg3': { air: 3, water: 8, records: 1 },
    'seg4': { air: -1, water: 1.5, records: 2 },
    'seg5': { air: -5, water: 0.3, records: 4 }
  };

  for (const seg of segments) {
    const segPoints = points.filter(p => p.canal_segment_id === seg.id);
    if (segPoints.length === 0) continue;

    const upstreamPoint = segPoints[0];
    const setup = tempSetup[seg.id] || { air: 5, water: 8, records: 1 };

    for (let i = 0; i < setup.records; i++) {
      const ts = now - (setup.records - i) * 30 * 60 * 1000;
      prepare(`
        INSERT INTO ice_temperature_records (point_id, air_temperature, water_temperature, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(upstreamPoint.id, setup.air, setup.water, ts);
    }
  }

  for (const seg of segments) {
    const setup = tempSetup[seg.id];
    if (!setup) {
      prepare(`
        INSERT OR IGNORE INTO ice_segment_status 
        (segment_id, status, ice_thickness, cumulative_negative_temp_hours, last_updated, consecutive_icing_count, consecutive_thaw_count)
        VALUES (?, 'normal', 0, 0, ?, 0, 0)
      `).run(seg.id, now);
      continue;
    }

    if (seg.id === 'seg5') {
      const cumNegHours = 11.11;
      const iceThickness = ICE_THICKNESS_COEFF * Math.sqrt(cumNegHours);
      prepare(`
        INSERT OR REPLACE INTO ice_segment_status 
        (segment_id, status, ice_thickness, cumulative_negative_temp_hours, frozen_at, last_updated, consecutive_icing_count, consecutive_thaw_count)
        VALUES (?, 'frozen', ?, ?, ?, ?, 3, 0)
      `).run(seg.id, iceThickness, cumNegHours, now - 2 * 60 * 60 * 1000, now);
    } else if (seg.id === 'seg4') {
      prepare(`
        INSERT OR REPLACE INTO ice_segment_status 
        (segment_id, status, ice_thickness, cumulative_negative_temp_hours, last_updated, consecutive_icing_count, consecutive_thaw_count)
        VALUES (?, 'warning', 0, 0, ?, 2, 0)
      `).run(seg.id, now);
    } else {
      prepare(`
        INSERT OR IGNORE INTO ice_segment_status 
        (segment_id, status, ice_thickness, cumulative_negative_temp_hours, last_updated, consecutive_icing_count, consecutive_thaw_count)
        VALUES (?, 'normal', 0, 0, ?, 0, 0)
      `).run(seg.id, now);
    }
  }

  prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('ice_demo_initialized', 'true');
  saveDatabase();
  console.log('冰期演示数据初始化完成: seg1-seg3正常, seg4预警, seg5结冰(冰厚约0.05m)');
}

module.exports = {
  recordTemperature,
  getRecentRecords,
  getAllSegmentStatus,
  getSegmentStatusDetail,
  getHydraulicAdjustments,
  getSegmentIceAdjustment,
  applyIceAdjustmentsToSegments,
  computeMinFlowForVelocity,
  getRecommendations,
  applyRecommendations,
  initIceDemoData,
  ICE_THICKNESS_COEFF,
  MIN_FLOW_VELOCITY
};
