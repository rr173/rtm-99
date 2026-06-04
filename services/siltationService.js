const { prepare, saveDatabase } = require('../db');
const hydraulicEngine = require('./hydraulicEngine');

function getDesignFlow(seg) {
  const A = hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, seg.design_water_level);
  const R = hydraulicEngine.trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, seg.design_water_level);
  return hydraulicEngine.manningDischarge(seg.manning_n, A, R, seg.bed_slope);
}

function getCapacityFlow(seg, siltationDepth) {
  const effH = seg.design_water_level - siltationDepth;
  if (effH <= 0) return 0;
  const A = hydraulicEngine.trapezoidalArea(seg.bottom_width, seg.side_slope, effH);
  const R = hydraulicEngine.trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effH);
  return hydraulicEngine.manningDischarge(seg.manning_n, A, R, seg.bed_slope);
}

function simulateSiltation(params) {
  const { days, rates } = params;
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const now = Date.now();

  const results = {};
  for (const seg of segments) {
    const rate = rates[seg.id] !== undefined ? rates[seg.id] : (rates.default || 0);
    const Qdesign = getDesignFlow(seg);
    let siltation = seg.siltation_depth || 0;
    const timeline = [];
    let exceedDate = null;

    timeline.push({
      day: 0,
      siltationDepth: siltation,
      capacityRatio: Qdesign > 0 ? getCapacityFlow(seg, siltation) / Qdesign : 1,
      capacityFlow: getCapacityFlow(seg, siltation)
    });

    for (let d = 1; d <= days; d++) {
      siltation += rate / 1000;
      const Qcap = getCapacityFlow(seg, siltation);
      const ratio = Qdesign > 0 ? Qcap / Qdesign : 1;

      timeline.push({
        day: d,
        siltationDepth: Math.round(siltation * 10000) / 10000,
        capacityRatio: Math.round(ratio * 10000) / 10000,
        capacityFlow: Math.round(Qcap * 1000) / 1000
      });

      if (exceedDate === null && ratio < 0.7) {
        exceedDate = d;
      }
    }

    results[seg.id] = {
      segmentId: seg.id,
      segmentName: seg.name,
      designFlow: Math.round(Qdesign * 1000) / 1000,
      initialSiltation: seg.siltation_depth || 0,
      dailyRateMm: rate,
      exceedDay: exceedDate,
      timeline: timeline
    };
  }

  return {
    simulateParams: { days, rates },
    designCapacityThreshold: 0.7,
    results
  };
}

function setSiltationDepth(segmentId, depth) {
  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
  if (!seg) return null;

  const clampedDepth = Math.max(0, depth);
  prepare('UPDATE canal_segments SET siltation_depth = ? WHERE id = ?').run(clampedDepth, segmentId);
  prepare('INSERT INTO siltation_history (segment_id, siltation_depth, source, timestamp) VALUES (?, ?, ?, ?)')
    .run(segmentId, clampedDepth, 'manual', Date.now());
  saveDatabase();

  return {
    segmentId,
    previousSiltation: seg.siltation_depth || 0,
    currentSiltation: clampedDepth,
    timestamp: Date.now()
  };
}

function getDredgingPlan() {
  const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const thirtyDaysLaterStr = thirtyDaysLater.toISOString().split('T')[0];

  const planItems = segments.map(seg => {
    const Qdesign = getDesignFlow(seg);
    const currentSiltation = seg.siltation_depth || 0;
    const Qcap = getCapacityFlow(seg, currentSiltation);
    const currentRatio = Qdesign > 0 ? Qcap / Qdesign : 1;

    let estimatedDailyRate = 0;
    const earliestRow = prepare(`
      SELECT siltation_depth, timestamp FROM siltation_history
      WHERE segment_id = ? AND source != 'work_order'
      ORDER BY timestamp ASC LIMIT 1
    `).get(seg.id);
    const latestRow = prepare(`
      SELECT siltation_depth, timestamp FROM siltation_history
      WHERE segment_id = ? AND source != 'work_order'
      ORDER BY timestamp DESC LIMIT 1
    `).get(seg.id);

    if (earliestRow && latestRow && latestRow.timestamp > earliestRow.timestamp) {
      const depthDelta = latestRow.siltation_depth - earliestRow.siltation_depth;
      const daysDelta = (latestRow.timestamp - earliestRow.timestamp) / (24 * 60 * 60 * 1000);
      if (daysDelta > 0) {
        estimatedDailyRate = Math.max(0, depthDelta / daysDelta);
      }
    }

    if (estimatedDailyRate <= 0) {
      estimatedDailyRate = 0.001;
    }

    let projectedSiltation = currentSiltation;
    let daysToExceed = null;
    for (let d = 1; d <= 365; d++) {
      projectedSiltation += estimatedDailyRate;
      const Qproj = getCapacityFlow(seg, projectedSiltation);
      if (Qdesign > 0 && Qproj / Qdesign < 0.7) {
        daysToExceed = d;
        break;
      }
    }

    let urgency = 'NORMAL';
    if (currentRatio < 0.7) {
      urgency = 'IMMEDIATE';
    } else if (daysToExceed !== null && daysToExceed <= 30) {
      urgency = 'SCHEDULED';
    }

    return {
      segmentId: seg.id,
      segmentName: seg.name,
      currentSiltation: currentSiltation,
      currentCapacityRatio: Math.round(currentRatio * 10000) / 10000,
      currentCapacityFlow: Math.round(Qcap * 1000) / 1000,
      designFlow: Math.round(Qdesign * 1000) / 1000,
      urgency,
      daysToExceed,
      estimatedDailyRate: Math.round(estimatedDailyRate * 10000) / 10000,
      needsDredging: urgency !== 'NORMAL'
    };
  });

  planItems.sort((a, b) => {
    const urgencyOrder = { IMMEDIATE: 0, SCHEDULED: 1, NORMAL: 2 };
    return urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || a.currentCapacityRatio - b.currentCapacityRatio;
  });

  return {
    timestamp: Date.now(),
    immediate: planItems.filter(p => p.urgency === 'IMMEDIATE'),
    scheduled: planItems.filter(p => p.urgency === 'SCHEDULED'),
    normal: planItems.filter(p => p.urgency === 'NORMAL'),
    allItems: planItems
  };
}

function generateOrderNumber() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const count = prepare('SELECT COUNT(*) as c FROM work_orders WHERE order_number LIKE ?').get(`WO-${dateStr}%`);
  const seq = (count.c + 1).toString().padStart(3, '0');
  return `WO-${dateStr}-${seq}`;
}

function createWorkOrders(segmentIds, plannedDate, targetSiltation) {
  const target = targetSiltation !== undefined ? targetSiltation : 0;
  const orders = [];
  const now = Date.now();

  for (const segId of segmentIds) {
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segId);
    if (!seg) continue;

    const existingPending = prepare(`
      SELECT COUNT(*) as c FROM work_orders
      WHERE segment_id = ? AND status IN ('pending', 'in_progress')
    `).get(segId);
    if (existingPending.c > 0) continue;

    const orderNumber = generateOrderNumber();
    prepare(`
      INSERT INTO work_orders (order_number, segment_id, current_siltation, target_siltation, planned_date, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(orderNumber, segId, seg.siltation_depth || 0, target, plannedDate, now);

    const order = prepare('SELECT * FROM work_orders WHERE order_number = ?').get(orderNumber);
    orders.push(order);
  }

  saveDatabase();
  return orders;
}

function completeWorkOrder(orderId) {
  const order = prepare('SELECT * FROM work_orders WHERE id = ?').get(orderId);
  if (!order) return null;
  if (order.status === 'completed') return { error: '工单已完成' };

  const now = Date.now();
  prepare('UPDATE work_orders SET status = ?, completed_at = ? WHERE id = ?')
    .run('completed', now, orderId);

  const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(order.segment_id);
  const previousSiltation = seg ? seg.siltation_depth : 0;
  const targetSiltation = order.target_siltation;

  prepare('UPDATE canal_segments SET siltation_depth = ? WHERE id = ?')
    .run(targetSiltation, order.segment_id);

  prepare('INSERT INTO siltation_history (segment_id, siltation_depth, source, timestamp) VALUES (?, ?, ?, ?)')
    .run(order.segment_id, targetSiltation, 'work_order', now);

  saveDatabase();

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    segmentId: order.segment_id,
    previousSiltation,
    newSiltation: targetSiltation,
    completedAt: now
  };
}

function getWorkOrders(filters) {
  const { status, segmentId } = filters || {};
  let sql = 'SELECT * FROM work_orders WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (segmentId) {
    sql += ' AND segment_id = ?';
    params.push(segmentId);
  }

  sql += ' ORDER BY created_at DESC';

  return prepare(sql).all(...params);
}

function getUnderConstructionSegmentIds() {
  const today = new Date().toISOString().split('T')[0];
  const activeOrders = prepare(`
    SELECT DISTINCT segment_id FROM work_orders
    WHERE status IN ('pending', 'in_progress') AND planned_date <= ?
  `).all(today);
  return activeOrders.map(o => o.segment_id);
}

function isSegmentUnderConstruction(segmentId) {
  const today = new Date().toISOString().split('T')[0];
  const active = prepare(`
    SELECT COUNT(*) as c FROM work_orders
    WHERE segment_id = ? AND status IN ('pending', 'in_progress') AND planned_date <= ?
  `).get(segmentId, today);
  return active.c > 0;
}

module.exports = {
  simulateSiltation,
  setSiltationDepth,
  getDredgingPlan,
  createWorkOrders,
  completeWorkOrder,
  getWorkOrders,
  getUnderConstructionSegmentIds,
  isSegmentUnderConstruction,
  getDesignFlow,
  getCapacityFlow
};
