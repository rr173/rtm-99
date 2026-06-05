const { prepare, exec, saveDatabase } = require('../db');

const demoCanalSegments = [
  {
    id: 'seg1',
    name: '渠段1-进口段',
    length: 1500,
    bottom_width: 8,
    side_slope: 1.5,
    manning_n: 0.025,
    bed_slope: 0.0002,
    design_water_level: 3.5,
    bottom_elevation: 100.0,
    order_index: 1,
    siltation_depth: 0,
    start_latitude: 39.9042,
    start_longitude: 116.4074,
    end_latitude: 39.8930,
    end_longitude: 116.4180
  },
  {
    id: 'seg2',
    name: '渠段2',
    length: 1800,
    bottom_width: 7,
    side_slope: 1.5,
    manning_n: 0.025,
    bed_slope: 0.0002,
    design_water_level: 3.2,
    bottom_elevation: 99.7,
    order_index: 2,
    siltation_depth: 0,
    start_latitude: 39.8930,
    start_longitude: 116.4180,
    end_latitude: 39.8800,
    end_longitude: 116.4320
  },
  {
    id: 'seg3',
    name: '渠段3-分水段',
    length: 1600,
    bottom_width: 6,
    side_slope: 1.5,
    manning_n: 0.025,
    bed_slope: 0.0002,
    design_water_level: 3.0,
    bottom_elevation: 99.34,
    order_index: 3,
    siltation_depth: 0.15,
    start_latitude: 39.8800,
    start_longitude: 116.4320,
    end_latitude: 39.8680,
    end_longitude: 116.4440
  },
  {
    id: 'seg4',
    name: '渠段4',
    length: 1700,
    bottom_width: 5,
    side_slope: 1.5,
    manning_n: 0.025,
    bed_slope: 0.0002,
    design_water_level: 2.8,
    bottom_elevation: 99.02,
    order_index: 4,
    siltation_depth: 0,
    start_latitude: 39.8680,
    start_longitude: 116.4440,
    end_latitude: 39.8540,
    end_longitude: 116.4580
  },
  {
    id: 'seg5',
    name: '渠段5-出口段',
    length: 1400,
    bottom_width: 5,
    side_slope: 1.5,
    manning_n: 0.025,
    bed_slope: 0.0002,
    design_water_level: 2.6,
    bottom_elevation: 98.68,
    order_index: 5,
    siltation_depth: 0.08,
    start_latitude: 39.8540,
    start_longitude: 116.4580,
    end_latitude: 39.8430,
    end_longitude: 116.4680
  }
];

const demoGates = [
  {
    id: 'gate1',
    name: '1号节制闸',
    type: 'regulator',
    max_opening: 2.0,
    current_opening: 0.8,
    gate_width: 4.0,
    discharge_coeff: 0.62,
    canal_segment_id: 'seg1',
    position_on_segment: 0
  },
  {
    id: 'gate2',
    name: '2号节制闸',
    type: 'regulator',
    max_opening: 1.8,
    current_opening: 0.7,
    gate_width: 3.5,
    discharge_coeff: 0.62,
    canal_segment_id: 'seg2',
    position_on_segment: 0
  },
  {
    id: 'gate3',
    name: '3号分水闸',
    type: 'diversion',
    max_opening: 1.5,
    current_opening: 0.5,
    gate_width: 2.5,
    discharge_coeff: 0.62,
    canal_segment_id: 'seg3',
    position_on_segment: 800
  },
  {
    id: 'gate4',
    name: '4号节制闸',
    type: 'regulator',
    max_opening: 1.6,
    current_opening: 0.65,
    gate_width: 3.0,
    discharge_coeff: 0.62,
    canal_segment_id: 'seg4',
    position_on_segment: 0
  }
];

const demoNodes = [
  { id: 'node0', name: '渠首进口', type: 'boundary', downstream_segment_id: 'seg1' },
  { id: 'node1', name: '1号闸节点', type: 'junction', upstream_segment_id: 'seg1', downstream_segment_id: 'seg2', gate_id: 'gate1' },
  { id: 'node2', name: '2号闸节点', type: 'junction', upstream_segment_id: 'seg2', downstream_segment_id: 'seg3', gate_id: 'gate2' },
  { id: 'node3', name: '分水节点', type: 'junction', upstream_segment_id: 'seg3', downstream_segment_id: 'seg4', gate_id: 'gate3' },
  { id: 'node4', name: '4号闸节点', type: 'junction', upstream_segment_id: 'seg4', downstream_segment_id: 'seg5', gate_id: 'gate4' },
  { id: 'node5', name: '渠尾出口', type: 'boundary', upstream_segment_id: 'seg5' }
];

function interpolatePointOnSegment(seg, distance) {
  const ratio = distance / seg.length;
  const lat = seg.start_latitude + ratio * (seg.end_latitude - seg.start_latitude);
  const lon = seg.start_longitude + ratio * (seg.end_longitude - seg.start_longitude);
  return { latitude: lat, longitude: lon };
}

function createMeasurementPoints() {
  const points = [];
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const gates = prepare('SELECT * FROM gates').all();

  const inletCoords = interpolatePointOnSegment(segments[0], 0);
  points.push({
    id: 'point_inlet',
    name: '渠首水位',
    canal_segment_id: segments[0].id,
    distance_from_upstream: 0,
    type: 'upstream_gate',
    gate_id: 'gate1',
    latitude: inletCoords.latitude,
    longitude: inletCoords.longitude
  });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segGates = gates.filter(g => g.canal_segment_id === seg.id && g.position_on_segment > 0);
    
    const downstreamGate = i < segments.length - 1 ? gates.find(g => g.position_on_segment === 0 && g.canal_segment_id === segments[i + 1].id) : null;
    const downCoords = interpolatePointOnSegment(seg, seg.length);
    points.push({
      id: `point_seg${i + 1}_down`,
      name: `${seg.name}-下游闸前水位`,
      canal_segment_id: seg.id,
      distance_from_upstream: seg.length,
      type: 'downstream_gate',
      gate_id: downstreamGate ? downstreamGate.id : null,
      latitude: downCoords.latitude,
      longitude: downCoords.longitude
    });

    const numIntermediate = Math.floor(seg.length / 500) - 1;
    for (let j = 1; j <= numIntermediate; j++) {
      const midCoords = interpolatePointOnSegment(seg, j * 500);
      points.push({
        id: `point_seg${i + 1}_mid${j}`,
        name: `${seg.name}-中间测点${j}`,
        canal_segment_id: seg.id,
        distance_from_upstream: j * 500,
        type: 'intermediate',
        gate_id: null,
        latitude: midCoords.latitude,
        longitude: midCoords.longitude
      });
    }

    for (const gate of segGates) {
      const upCoords = interpolatePointOnSegment(seg, gate.position_on_segment - 50);
      points.push({
        id: `point_${gate.id}_up`,
        name: `${gate.name}-闸前水位`,
        canal_segment_id: seg.id,
        distance_from_upstream: gate.position_on_segment - 50,
        type: 'upstream_gate',
        gate_id: gate.id,
        latitude: upCoords.latitude,
        longitude: upCoords.longitude
      });
      const downCoordsGate = interpolatePointOnSegment(seg, gate.position_on_segment + 50);
      points.push({
        id: `point_${gate.id}_down`,
        name: `${gate.name}-闸后水位`,
        canal_segment_id: seg.id,
        distance_from_upstream: gate.position_on_segment + 50,
        type: 'downstream_gate',
        gate_id: gate.id,
        latitude: downCoordsGate.latitude,
        longitude: downCoordsGate.longitude
      });
    }
  }

  return points;
}

function initDemoTopology() {
  const existingSegments = prepare('SELECT COUNT(*) as count FROM canal_segments').get();
  if (existingSegments && existingSegments.count > 0) return;

  for (const seg of demoCanalSegments) {
    prepare(`
      INSERT INTO canal_segments (id, name, length, bottom_width, side_slope, manning_n, 
        bed_slope, design_water_level, bottom_elevation, order_index, siltation_depth,
        start_latitude, start_longitude, end_latitude, end_longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seg.id, seg.name, seg.length, seg.bottom_width, seg.side_slope, 
      seg.manning_n, seg.bed_slope, seg.design_water_level, seg.bottom_elevation, seg.order_index,
      seg.siltation_depth || 0, seg.start_latitude, seg.start_longitude, seg.end_latitude, seg.end_longitude);
  }
  
  for (const gate of demoGates) {
    prepare(`
      INSERT INTO gates (id, name, type, max_opening, current_opening, gate_width, 
        discharge_coeff, canal_segment_id, position_on_segment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gate.id, gate.name, gate.type, gate.max_opening, gate.current_opening, 
      gate.gate_width, gate.discharge_coeff, gate.canal_segment_id, gate.position_on_segment);
  }
  
  for (const node of demoNodes) {
    prepare(`
      INSERT INTO nodes (id, name, type, upstream_segment_id, downstream_segment_id, gate_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(node.id, node.name, node.type, node.upstream_segment_id || null, 
      node.downstream_segment_id || null, node.gate_id || null);
  }

  const points = createMeasurementPoints();
  
  for (const point of points) {
    prepare(`
      INSERT INTO measurement_points (id, name, canal_segment_id, distance_from_upstream, type, gate_id, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(point.id, point.name, point.canal_segment_id, point.distance_from_upstream, 
      point.type, point.gate_id !== undefined ? point.gate_id : null,
      point.latitude, point.longitude);
  }

  const exists = prepare('SELECT 1 FROM system_state WHERE key = ?').get('initialized');
  if (!exists) {
    prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('initialized', 'true');
  } else {
    prepare('UPDATE system_state SET value = ? WHERE key = ?').run('true', 'initialized');
  }

  saveDatabase();
  console.log('演示拓扑初始化完成: 5段渠道 + 4个闸门');
}

function generateNormalWaterLevel(segment, distance, baseTime) {
  const sd = segment.siltation_depth || 0;
  const effectiveDesignDepth = segment.design_water_level - sd;
  const normalDepth = effectiveDesignDepth * 0.7 + sd;
  const dropAlong = segment.bed_slope * distance;
  const seasonalVariation = Math.sin(baseTime / 86400000 * Math.PI * 2) * 0.05;
  const noise = (Math.random() - 0.5) * 0.03;
  return segment.bottom_elevation + normalDepth - dropAlong + seasonalVariation + noise;
}

function generateHistoricalData() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  
  const existing = prepare('SELECT COUNT(*) as count FROM water_level_history').get();
  if (existing && existing.count > 0) return;

  const points = prepare('SELECT * FROM measurement_points').all();
  const segments = prepare('SELECT * FROM canal_segments').all();
  const segMap = {};
  for (const s of segments) segMap[s.id] = s;

  for (const point of points) {
    const seg = segMap[point.canal_segment_id];
    for (let t = oneHourAgo; t <= now; t += 30 * 1000) {
      const wl = generateNormalWaterLevel(seg, point.distance_from_upstream, t);
      prepare(`
        INSERT INTO water_level_history (point_id, water_level, timestamp)
        VALUES (?, ?, ?)
      `).run(point.id, wl, t);
    }
  }

  saveDatabase();
  console.log('模拟历史数据生成完成: 最近1小时, 30秒间隔');
}

function initSiltationDemoData() {
  const existing = prepare('SELECT 1 FROM system_state WHERE key = ?').get('siltation_demo_initialized');
  if (existing) return;

  const demoSiltation = {
    'seg3': 0.15,
    'seg5': 0.08
  };

  const now = Date.now();
  for (const [segId, depth] of Object.entries(demoSiltation)) {
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segId);
    if (seg && (seg.siltation_depth || 0) === 0) {
      prepare('UPDATE canal_segments SET siltation_depth = ? WHERE id = ?').run(depth, segId);
      prepare('INSERT INTO siltation_history (segment_id, siltation_depth, source, timestamp) VALUES (?, ?, ?, ?)')
        .run(segId, depth, 'demo', now);
    }
  }

  prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('siltation_demo_initialized', 'true');
  saveDatabase();
  console.log('淤积演示数据初始化完成: seg3=0.15m, seg5=0.08m');
}

function initGeoCoordinates() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const points = prepare('SELECT * FROM measurement_points').all();

  global.segmentCoordinates = {};
  for (const seg of segments) {
    if (seg.start_latitude !== null && seg.start_longitude !== null &&
        seg.end_latitude !== null && seg.end_longitude !== null) {
      global.segmentCoordinates[seg.id] = {
        start_lat: seg.start_latitude,
        start_lon: seg.start_longitude,
        end_lat: seg.end_latitude,
        end_lon: seg.end_longitude
      };
    }
  }

  global.pointCoordinates = {};
  for (const point of points) {
    if (point.latitude !== null && point.longitude !== null) {
      global.pointCoordinates[point.id] = {
        latitude: point.latitude,
        longitude: point.longitude
      };
    }
  }

  console.log('地理坐标映射初始化完成');
}

function initDemoPatrolRoute() {
  const existing = prepare('SELECT COUNT(*) as count FROM patrol_routes').get();
  if (existing && existing.count > 0) return;

  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  if (segments.length === 0) return;

  const checkpoints = [];
  const totalPoints = 10;
  const pointsPerSegment = 2;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    for (let ptIdx = 0; ptIdx < pointsPerSegment; ptIdx++) {
      const distance = seg.length * (ptIdx + 1) / (pointsPerSegment + 1);
      const coords = interpolatePointOnSegment(seg, distance);
      checkpoints.push({
        latitude: Math.round(coords.latitude * 1000000) / 1000000,
        longitude: Math.round(coords.longitude * 1000000) / 1000000,
        canal_segment_id: seg.id,
        description: `${seg.name}-巡检点${ptIdx + 1}`
      });
    }
  }

  const patrolService = require('../services/patrolService');
  const totalLength = require('../services/geoUtils').calculateTotalDistance(checkpoints);
  const estimatedMinutes = Math.ceil(totalLength / 80);

  try {
    patrolService.createRoute(
      '全线常规巡检路线',
      estimatedMinutes,
      checkpoints
    );
    console.log(`演示巡检路线初始化完成: ${checkpoints.length}个巡检点, 总长约${Math.round(totalLength)}m`);
  } catch (err) {
    console.error('初始化演示巡检路线失败:', err.message);
  }
}

function initDemoEmergencyPlans() {
  const existing = prepare('SELECT COUNT(*) as count FROM emergency_plans').get();
  if (existing && existing.count > 0) return;

  const now = Date.now();

  const plan1Result = prepare(`
    INSERT INTO emergency_plans (name, priority, effective_start_time, effective_end_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('上游来水暴涨应急预案', 1, null, null, now, now);

  const plan1Id = plan1Result.lastInsertRowid;

  prepare(`
    INSERT INTO emergency_plan_conditions (plan_id, type, target_id, operator, threshold, tolerance, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(plan1Id, 'water_level', 'point_inlet', '>', 103.0, null, null);

  const actions1 = [
    { gateId: 'gate2', targetOpening: 20, adjustmentType: 'relative' },
    { gateId: 'gate3', targetOpening: 20, adjustmentType: 'relative' },
    { gateId: 'gate4', targetOpening: 20, adjustmentType: 'relative' }
  ];

  for (let i = 0; i < actions1.length; i++) {
    prepare(`
      INSERT INTO emergency_plan_actions (plan_id, order_index, gate_id, target_opening, adjustment_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(plan1Id, i, actions1[i].gateId, actions1[i].targetOpening, actions1[i].adjustmentType);
  }

  const plan2Result = prepare(`
    INSERT INTO emergency_plans (name, priority, effective_start_time, effective_end_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('分水闸故障保护预案', 2, null, null, now + 1, now + 1);

  const plan2Id = plan2Result.lastInsertRowid;

  prepare(`
    INSERT INTO emergency_plan_conditions (plan_id, type, target_id, operator, threshold, tolerance, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(plan2Id, 'gate_fault', 'gate3', '>', 0.3, 0.3, 60);

  prepare(`
    INSERT INTO emergency_plan_actions (plan_id, order_index, gate_id, target_opening, adjustment_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(plan2Id, 0, 'gate2', 0.3, 'absolute');

  saveDatabase();
  console.log('演示预案初始化完成: 2条应急预案');
}

function initLinkMonitorDemoData() {
  const linkMonitorService = require('../services/linkMonitorService');
  linkMonitorService.initLinkMonitorData();
}

module.exports = {
  initDemoTopology,
  generateHistoricalData,
  initSiltationDemoData,
  initGeoCoordinates,
  initDemoPatrolRoute,
  initDemoEmergencyPlans,
  initLinkMonitorDemoData,
  demoCanalSegments,
  demoGates
};
