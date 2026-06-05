const { prepare, saveDatabase } = require('../db');

const simulatedOutages = new Map();

function getPointStatus(pointId) {
  const now = Date.now();
  const heartbeat = prepare(`
    SELECT timestamp FROM link_monitor_heartbeats 
    WHERE point_id = ? 
    ORDER BY timestamp DESC LIMIT 1
  `).get(pointId);

  const lastHeartbeat = heartbeat ? heartbeat.timestamp : 0;
  const secondsSinceHeartbeat = Math.floor((now - lastHeartbeat) / 1000);

  let status = 'offline';
  if (secondsSinceHeartbeat <= 60) {
    status = 'online';
  } else if (secondsSinceHeartbeat <= 300) {
    status = 'delayed';
  }

  return {
    pointId,
    lastHeartbeatTime: lastHeartbeat,
    secondsSinceHeartbeat,
    status
  };
}

function getAllPointsStatus() {
  const points = prepare('SELECT id, name, canal_segment_id FROM measurement_points').all();
  const result = [];

  for (const point of points) {
    const status = getPointStatus(point.id);
    result.push({
      ...status,
      pointName: point.name,
      segmentId: point.canal_segment_id
    });
  }

  return result;
}

function getPointLinkDetail(pointId) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const point = prepare('SELECT name, canal_segment_id FROM measurement_points WHERE id = ?').get(pointId);
  if (!point) return null;

  const heartbeats = prepare(`
    SELECT timestamp FROM link_monitor_heartbeats 
    WHERE point_id = ? AND timestamp >= ? 
    ORDER BY timestamp ASC
  `).all(pointId, oneHourAgo);

  const theoreticalCount = 120;
  const actualCount = heartbeats.length;
  const packetLossRate = theoreticalCount > 0 
    ? Math.max(0, (theoreticalCount - actualCount) / theoreticalCount * 100) 
    : 100;

  let avgInterval = 0;
  let maxInterval = 0;
  let consecutiveOnlineSeconds = 0;

  if (heartbeats.length > 1) {
    const intervals = [];
    for (let i = 1; i < heartbeats.length; i++) {
      const interval = (heartbeats[i].timestamp - heartbeats[i - 1].timestamp) / 1000;
      intervals.push(interval);
      maxInterval = Math.max(maxInterval, interval);
    }
    avgInterval = intervals.length > 0 
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length 
      : 0;
  }

  if (heartbeats.length > 0) {
    const latestHeartbeat = heartbeats[heartbeats.length - 1].timestamp;
    let lastGap = 0;
    for (let i = heartbeats.length - 1; i > 0; i--) {
      const gap = (heartbeats[i].timestamp - heartbeats[i - 1].timestamp) / 1000;
      if (gap > 300) {
        lastGap = i;
        break;
      }
    }
    const consecutiveHeartbeats = heartbeats.slice(lastGap);
    if (consecutiveHeartbeats.length > 0) {
      consecutiveOnlineSeconds = (now - consecutiveHeartbeats[0].timestamp) / 1000;
    }
  }

  const basicStatus = getPointStatus(pointId);

  return {
    ...basicStatus,
    pointName: point.name,
    segmentId: point.canal_segment_id,
    oneHourStats: {
      theoreticalCount,
      actualCount,
      packetLossRate: Math.round(packetLossRate * 100) / 100,
      avgIntervalSeconds: Math.round(avgInterval * 100) / 100,
      maxIntervalSeconds: Math.round(maxInterval * 100) / 100,
      consecutiveOnlineSeconds: Math.round(consecutiveOnlineSeconds)
    }
  };
}

function recordHeartbeats(heartbeatData) {
  if (!Array.isArray(heartbeatData) || heartbeatData.length === 0) {
    return { received: 0, processed: 0 };
  }

  const stmt = prepare(`
    INSERT INTO link_monitor_heartbeats (point_id, timestamp, source)
    VALUES (?, ?, ?)
  `);

  let processed = 0;
  const now = Date.now();

  for (const hb of heartbeatData) {
    if (hb.pointId) {
      if (isPointSimulatedOffline(hb.pointId, hb.timestamp || now)) {
        continue;
      }
      stmt.run(hb.pointId, hb.timestamp || now, 'heartbeat');
      processed++;
    }
  }

  saveDatabase();
  cleanupOldHeartbeats();

  return {
    received: heartbeatData.length,
    processed
  };
}

function isPointSimulatedOffline(pointId, timestamp) {
  if (!simulatedOutages.has(pointId)) return false;
  
  const outage = simulatedOutages.get(pointId);
  const now = timestamp || Date.now();
  
  if (now > outage.endTime) {
    simulatedOutages.delete(pointId);
    return false;
  }
  
  return true;
}

function simulateOutage(pointId, durationSeconds) {
  const point = prepare('SELECT 1 FROM measurement_points WHERE id = ?').get(pointId);
  if (!point) {
    return { success: false, error: '测点不存在' };
  }

  const now = Date.now();
  simulatedOutages.set(pointId, {
    startTime: now,
    endTime: now + durationSeconds * 1000,
    durationSeconds
  });

  return {
    success: true,
    pointId,
    startTime: now,
    endTime: now + durationSeconds * 1000,
    durationSeconds
  };
}

function diagnoseDataQuality(pointId, windowHours = 6) {
  const now = Date.now();
  const startTime = now - windowHours * 60 * 60 * 1000;

  const point = prepare(`
    SELECT mp.*, cs.bottom_elevation, cs.design_water_level 
    FROM measurement_points mp
    JOIN canal_segments cs ON mp.canal_segment_id = cs.id
    WHERE mp.id = ?
  `).get(pointId);

  if (!point) return null;

  const waterLevels = prepare(`
    SELECT water_level, timestamp 
    FROM water_level_history 
    WHERE point_id = ? AND timestamp >= ? 
    ORDER BY timestamp ASC
  `).all(pointId, startTime);

  const theoreticalCount = (windowHours * 60 * 60) / 30;
  const actualCount = waterLevels.length;
  const packetLossRate = theoreticalCount > 0
    ? Math.max(0, (theoreticalCount - actualCount) / theoreticalCount * 100)
    : 100;

  const jumpDetails = [];
  const stuckPeriods = [];
  const outOfBoundsDetails = [];

  for (let i = 1; i < waterLevels.length; i++) {
    const diff = Math.abs(waterLevels[i].water_level - waterLevels[i - 1].water_level);
    if (diff > 0.5) {
      jumpDetails.push({
        timestamp: waterLevels[i].timestamp,
        previousLevel: waterLevels[i - 1].water_level,
        currentLevel: waterLevels[i].water_level,
        difference: diff
      });
    }
  }

  if (waterLevels.length >= 10) {
    let stuckStart = 0;
    let stuckValue = waterLevels[0].water_level;
    let stuckCount = 1;

    for (let i = 1; i < waterLevels.length; i++) {
      const currentLevel = Math.round(waterLevels[i].water_level * 1000) / 1000;
      const prevLevel = Math.round(stuckValue * 1000) / 1000;

      if (currentLevel === prevLevel) {
        stuckCount++;
      } else {
        if (stuckCount >= 10) {
          stuckPeriods.push({
            startTime: waterLevels[stuckStart].timestamp,
            endTime: waterLevels[i - 1].timestamp,
            durationSeconds: (waterLevels[i - 1].timestamp - waterLevels[stuckStart].timestamp) / 1000,
            waterLevel: stuckValue,
            count: stuckCount
          });
        }
        stuckStart = i;
        stuckValue = waterLevels[i].water_level;
        stuckCount = 1;
      }
    }

    if (stuckCount >= 10) {
      stuckPeriods.push({
        startTime: waterLevels[stuckStart].timestamp,
        endTime: waterLevels[waterLevels.length - 1].timestamp,
        durationSeconds: (waterLevels[waterLevels.length - 1].timestamp - waterLevels[stuckStart].timestamp) / 1000,
        waterLevel: stuckValue,
        count: stuckCount
      });
    }
  }

  const bottomElevation = point.bottom_elevation;
  const maxWaterLevel = bottomElevation + point.design_water_level;

  for (const wl of waterLevels) {
    if (wl.water_level < bottomElevation || wl.water_level > maxWaterLevel) {
      outOfBoundsDetails.push({
        timestamp: wl.timestamp,
        waterLevel: wl.water_level,
        type: wl.water_level < bottomElevation ? 'below_bottom' : 'above_design'
      });
    }
  }

  let stdDev = 0;
  let noiseLevel = 'normal';

  if (waterLevels.length > 0) {
    const levels = waterLevels.map(w => w.water_level);
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const variance = levels.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / levels.length;
    stdDev = Math.sqrt(variance);

    if (stdDev < 0.001) {
      noiseLevel = '疑似卡值';
    } else if (stdDev > 0.3) {
      noiseLevel = '噪声过大';
    }
  }

  const totalStuckSeconds = stuckPeriods.reduce((a, b) => a + b.durationSeconds, 0);

  const score = calculateQualityScore(
    packetLossRate,
    jumpDetails.length,
    totalStuckSeconds,
    outOfBoundsDetails.length
  );

  const diagnosis = {
    pointId,
    pointName: point.name,
    segmentId: point.canal_segment_id,
    diagnosisTime: now,
    windowHours,
    dataPoints: actualCount,
    theoreticalPoints: theoreticalCount,
    packetLossRate: Math.round(packetLossRate * 100) / 100,
    jumpDetection: {
      count: jumpDetails.length,
      details: jumpDetails
    },
    stuckDetection: {
      periodCount: stuckPeriods.length,
      totalDurationSeconds: Math.round(totalStuckSeconds),
      periods: stuckPeriods
    },
    outOfBoundsDetection: {
      count: outOfBoundsDetails.length,
      bottomElevation,
      maxDesignLevel: maxWaterLevel,
      details: outOfBoundsDetails
    },
    noiseAssessment: {
      stdDev: Math.round(stdDev * 10000) / 10000,
      level: noiseLevel
    },
    qualityScore: score
  };

  cacheDiagnosis(pointId, diagnosis, windowHours);

  return diagnosis;
}

function calculateQualityScore(packetLossRate, jumpCount, stuckSeconds, outOfBoundsCount) {
  const packetLossScore = Math.max(0, 30 - (packetLossRate / 100) * 30);
  const jumpScore = Math.max(0, 25 - jumpCount * 5);
  const stuckHours = stuckSeconds / 3600;
  const stuckScore = Math.max(0, 25 - stuckHours * 10);
  const outOfBoundsScore = Math.max(0, 20 - outOfBoundsCount * 4);

  return Math.round((packetLossScore + jumpScore + stuckScore + outOfBoundsScore) * 100) / 100;
}

function cacheDiagnosis(pointId, diagnosis, windowHours) {
  prepare(`
    INSERT INTO link_monitor_diagnostics (
      point_id, diagnosis_time, window_hours, packet_loss_rate, jump_count,
      jump_details, stuck_duration_seconds, stuck_periods, out_of_bounds_count,
      out_of_bounds_details, std_dev, noise_level, quality_score, link_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pointId,
    diagnosis.diagnosisTime,
    windowHours,
    diagnosis.packetLossRate,
    diagnosis.jumpDetection.count,
    JSON.stringify(diagnosis.jumpDetection.details),
    diagnosis.stuckDetection.totalDurationSeconds,
    JSON.stringify(diagnosis.stuckDetection.periods),
    diagnosis.outOfBoundsDetection.count,
    JSON.stringify(diagnosis.outOfBoundsDetection.details),
    diagnosis.noiseAssessment.stdDev,
    diagnosis.noiseAssessment.level,
    diagnosis.qualityScore,
    getPointStatus(pointId).status
  );
  saveDatabase();
}

function getAllPointsQualityScores() {
  const points = prepare('SELECT id, name, canal_segment_id FROM measurement_points').all();
  const result = [];

  for (const point of points) {
    const diagnosis = diagnoseDataQuality(point.id, 6);
    if (diagnosis) {
      result.push({
        pointId: point.id,
        pointName: point.name,
        segmentId: point.canal_segment_id,
        qualityScore: diagnosis.qualityScore,
        packetLossRate: diagnosis.packetLossRate,
        jumpCount: diagnosis.jumpDetection.count,
        stuckDurationSeconds: diagnosis.stuckDetection.totalDurationSeconds,
        outOfBoundsCount: diagnosis.outOfBoundsDetection.count
      });
    }
  }

  return result;
}

function generateHealthReport() {
  const now = Date.now();
  const allStatus = getAllPointsStatus();
  const allScores = getAllPointsQualityScores();

  const scoreMap = {};
  for (const s of allScores) {
    scoreMap[s.pointId] = s;
  }

  const combined = allStatus.map(s => ({
    ...s,
    ...scoreMap[s.pointId]
  }));

  const rankedByScore = [...combined].sort((a, b) => b.qualityScore - a.qualityScore);
  const offlinePoints = combined.filter(p => p.status === 'offline');
  const worstQuality = [...combined]
    .sort((a, b) => a.qualityScore - b.qualityScore)
    .slice(0, 3);

  const avgPacketLoss = combined.length > 0
    ? combined.reduce((a, b) => a + (b.packetLossRate || 0), 0) / combined.length
    : 0;

  const maintenancePoints = combined.filter(p => (p.qualityScore || 0) < 60);

  const suggestions = generateSuggestions(combined);

  return {
    reportTime: now,
    totalPoints: combined.length,
    onlineCount: combined.filter(p => p.status === 'online').length,
    delayedCount: combined.filter(p => p.status === 'delayed').length,
    offlineCount: offlinePoints.length,
    averagePacketLossRate: Math.round(avgPacketLoss * 100) / 100,
    averageQualityScore: Math.round(
      combined.reduce((a, b) => a + (b.qualityScore || 0), 0) / combined.length * 100
    ) / 100,
    rankings: {
      byQualityScore: rankedByScore.map(p => ({
        pointId: p.pointId,
        pointName: p.pointName,
        qualityScore: p.qualityScore,
        status: p.status
      }))
    },
    offlinePoints: offlinePoints.map(p => ({
      pointId: p.pointId,
      pointName: p.pointName,
      secondsSinceHeartbeat: p.secondsSinceHeartbeat,
      lastHeartbeatTime: p.lastHeartbeatTime
    })),
    worstQualityPoints: worstQuality.map(p => ({
      pointId: p.pointId,
      pointName: p.pointName,
      qualityScore: p.qualityScore,
      issues: getIssueSummary(p)
    })),
    maintenanceRecommended: maintenancePoints.map(p => ({
      pointId: p.pointId,
      pointName: p.pointName,
      qualityScore: p.qualityScore,
      issues: getIssueSummary(p)
    })),
    suggestions
  };
}

function getIssueSummary(point) {
  const issues = [];
  if (point.status === 'offline') issues.push('链路离线');
  if (point.status === 'delayed') issues.push('链路延迟');
  if ((point.packetLossRate || 0) > 10) issues.push('丢包严重');
  if ((point.jumpCount || 0) > 0) issues.push(`水位跳变${point.jumpCount}次`);
  if ((point.stuckDurationSeconds || 0) > 0) issues.push('数据卡值');
  if ((point.outOfBoundsCount || 0) > 0) issues.push(`越界${point.outOfBoundsCount}次`);
  return issues;
}

function generateSuggestions(combined) {
  const suggestions = [];

  const offline = combined.filter(p => p.status === 'offline');
  if (offline.length > 0) {
    suggestions.push({
      priority: 'high',
      type: 'link',
      message: `${offline.length}个测点离线，请立即检查通信链路`,
      points: offline.map(p => p.pointId)
    });
  }

  const highLoss = combined.filter(p => (p.packetLossRate || 0) > 20);
  if (highLoss.length > 0) {
    suggestions.push({
      priority: 'medium',
      type: 'packet_loss',
      message: `${highLoss.length}个测点丢包率超过20%，建议检查RTU信号强度`,
      points: highLoss.map(p => p.pointId)
    });
  }

  const stuck = combined.filter(p => (p.stuckDurationSeconds || 0) > 300);
  if (stuck.length > 0) {
    suggestions.push({
      priority: 'medium',
      type: 'sensor',
      message: `${stuck.length}个测点存在数据卡值现象，传感器可能故障`,
      points: stuck.map(p => p.pointId)
    });
  }

  const lowScore = combined.filter(p => (p.qualityScore || 0) < 60);
  if (lowScore.length > 0) {
    suggestions.push({
      priority: 'high',
      type: 'maintenance',
      message: `${lowScore.length}个测点综合评分低于60分，建议安排维护`,
      points: lowScore.map(p => p.pointId)
    });
  }

  return suggestions;
}

function cleanupOldHeartbeats() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  prepare('DELETE FROM link_monitor_heartbeats WHERE timestamp < ?').run(cutoff);
  saveDatabase();
}

function initLinkMonitorData() {
  const existing = prepare('SELECT COUNT(*) as count FROM link_monitor_heartbeats').get();
  if (existing && existing.count > 0) return;

  const points = prepare('SELECT id FROM measurement_points').all();
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const tenMinutesAgo = now - 10 * 60 * 1000;

  const stmt = prepare(`
    INSERT INTO link_monitor_heartbeats (point_id, timestamp, source)
    VALUES (?, ?, ?)
  `);

  for (const point of points) {
    const isOfflinePoint = point.id === 'point_seg3_down';
    
    for (let t = oneHourAgo; t <= now; t += 30 * 1000) {
      if (isOfflinePoint && t >= tenMinutesAgo) {
        continue;
      }
      stmt.run(point.id, t, 'simulated');
    }
  }

  saveDatabase();
  console.log('链路监控心跳数据初始化完成: point_seg3_down模拟离线(最近10分钟无心跳)');
}

module.exports = {
  getPointStatus,
  getAllPointsStatus,
  getPointLinkDetail,
  recordHeartbeats,
  simulateOutage,
  diagnoseDataQuality,
  getAllPointsQualityScores,
  generateHealthReport,
  initLinkMonitorData,
  isPointSimulatedOffline
};
