const { prepare, saveDatabase, exec } = require('../db');

function getTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getMonthStr(date) {
  const d = date ? new Date(date) : new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0');
}

function createTariff(data) {
  const now = Date.now();
  const { name, effective_date, tiers } = data;

  if (!name) throw new Error('方案名不能为空');
  if (!effective_date) throw new Error('生效日期不能为空');
  if (!tiers || !Array.isArray(tiers) || tiers.length < 2) {
    throw new Error('阶梯档位至少需要两档');
  }

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.start_volume === undefined || t.start_volume === null || isNaN(parseFloat(t.start_volume))) {
      throw new Error(`第${i + 1}档缺少起始量`);
    }
    if (i < tiers.length - 1 && (t.end_volume === undefined || t.end_volume === null || isNaN(parseFloat(t.end_volume)))) {
      throw new Error(`第${i + 1}档缺少截止量`);
    }
    if (t.unit_price === undefined || t.unit_price === null || isNaN(parseFloat(t.unit_price)) || parseFloat(t.unit_price) <= 0) {
      throw new Error(`第${i + 1}档单价无效`);
    }
  }

  for (let i = 1; i < tiers.length; i++) {
    if (parseFloat(tiers[i].start_volume) <= parseFloat(tiers[i - 1].start_volume)) {
      throw new Error(`阶梯起始量必须递增`);
    }
    if (tiers[i - 1].end_volume !== undefined && tiers[i - 1].end_volume !== null) {
      if (parseFloat(tiers[i].start_volume) < parseFloat(tiers[i - 1].end_volume)) {
        throw new Error(`阶梯区间不能重叠`);
      }
    }
  }

  const existingActive = prepare('SELECT * FROM billing_tariffs WHERE is_active = 1').get();
  let shouldActivate = false;
  if (!existingActive) {
    shouldActivate = true;
  } else {
    const effDate = new Date(effective_date).getTime();
    const activeEffDate = new Date(existingActive.effective_date).getTime();
    if (effDate >= activeEffDate) {
      shouldActivate = true;
    }
  }

  if (shouldActivate) {
    prepare('UPDATE billing_tariffs SET is_active = 0, updated_at = ? WHERE is_active = 1').run(now);
  }

  const result = prepare(`
    INSERT INTO billing_tariffs (name, effective_date, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, effective_date, shouldActivate ? 1 : 0, now, now);

  const tariffId = result.lastInsertRowid;

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    prepare(`
      INSERT INTO billing_tariff_tiers (tariff_id, tier_index, start_volume, end_volume, unit_price)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      tariffId,
      i,
      parseFloat(t.start_volume),
      (t.end_volume !== undefined && t.end_volume !== null) ? parseFloat(t.end_volume) : null,
      parseFloat(t.unit_price)
    );
  }

  saveDatabase();
  return getTariffWithTiers(tariffId);
}

function getTariffWithTiers(tariffId) {
  const tariff = prepare('SELECT * FROM billing_tariffs WHERE id = ?').get(tariffId);
  if (!tariff) return null;

  const tiers = prepare(`
    SELECT * FROM billing_tariff_tiers 
    WHERE tariff_id = ? 
    ORDER BY tier_index ASC
  `).all(tariffId);

  return {
    ...tariff,
    is_active: tariff.is_active === 1,
    tiers: tiers.map(t => ({
      id: t.id,
      tier_index: t.tier_index,
      start_volume: t.start_volume,
      end_volume: t.end_volume,
      unit_price: t.unit_price
    }))
  };
}

function getAllTariffs() {
  const tariffs = prepare('SELECT * FROM billing_tariffs ORDER BY effective_date DESC, id DESC').all();
  return tariffs.map(t => {
    const tiers = prepare(`
      SELECT * FROM billing_tariff_tiers 
      WHERE tariff_id = ? 
      ORDER BY tier_index ASC
    `).all(t.id);
    return {
      ...t,
      is_active: t.is_active === 1,
      tiers: tiers.map(tier => ({
        id: tier.id,
        tier_index: tier.tier_index,
        start_volume: tier.start_volume,
        end_volume: tier.end_volume,
        unit_price: tier.unit_price
      }))
    };
  });
}

function getCurrentTariff() {
  const active = prepare('SELECT * FROM billing_tariffs WHERE is_active = 1').get();
  if (!active) return null;
  return getTariffWithTiers(active.id);
}

function getTariffForMonth(monthStr) {
  if (!monthStr) return getCurrentTariff();
  const yearMonth = monthStr.substring(0, 7);
  const tariffs = prepare(`
    SELECT * FROM billing_tariffs 
    WHERE substr(effective_date, 1, 7) <= ? 
    ORDER BY effective_date DESC, id DESC
  `).all(yearMonth);
  if (tariffs.length === 0) return getCurrentTariff();
  return getTariffWithTiers(tariffs[0].id);
}

function accumulateHourlyUsage() {
  const now = Date.now();
  const nowDate = new Date(now);
  const dateStr = getTodayStr();
  const hour = nowDate.getHours();

  const irrigations = prepare('SELECT * FROM dispatch_irrigations').all();
  const gates = prepare('SELECT * FROM gates').all();
  const gateMap = {};
  for (const g of gates) gateMap[g.id] = g;

  for (const irrig of irrigations) {
    if (!irrig.last_calc_time || irrig.last_calc_time <= 0) {
      prepare('UPDATE dispatch_irrigations SET last_calc_time = ? WHERE id = ?').run(now, irrig.id);
      continue;
    }

    const dt = (now - irrig.last_calc_time) / 1000;
    if (dt <= 0 || dt > 3600 * 24) {
      prepare('UPDATE dispatch_irrigations SET last_calc_time = ? WHERE id = ?').run(now, irrig.id);
      continue;
    }

    const gate = gateMap[irrig.gate_id];
    if (!gate) continue;

    const H_up = getGateUpstreamDepthSimple(gate);
    const currentQ = calculateWeirFlowSimple(
      gate.discharge_coeff,
      gate.gate_width,
      gate.current_opening,
      H_up
    );

    const volume = currentQ * dt;

    if (volume > 0) {
      const existing = prepare(`
        SELECT * FROM billing_usage_records 
        WHERE irrigation_id = ? AND record_date = ? AND record_hour = ?
      `).get(irrig.id, dateStr, hour);

      if (existing) {
        prepare(`
          UPDATE billing_usage_records 
          SET volume = volume + ?, timestamp = ?
          WHERE id = ?
        `).run(volume, now, existing.id);
      } else {
        prepare(`
          INSERT INTO billing_usage_records 
          (irrigation_id, irrigation_name, record_date, record_hour, volume, source, timestamp)
          VALUES (?, ?, ?, ?, ?, 'auto', ?)
        `).run(irrig.id, irrig.name, dateStr, hour, volume, now);
      }

      prepare(`
        UPDATE dispatch_irrigations SET last_calc_time = ?, updated_at = ? WHERE id = ?
      `).run(now, now, irrig.id);
    } else {
      prepare('UPDATE dispatch_irrigations SET last_calc_time = ? WHERE id = ?').run(now, irrig.id);
    }
  }

  saveDatabase();
}

const g = 9.81;

function calculateWeirFlowSimple(Cd, b, e, H_up) {
  if (e <= 0.001 || H_up <= e * 1.05) return 0;
  return Cd * b * e * Math.sqrt(2 * g * (H_up - e));
}

function getGateUpstreamDepthSimple(gate) {
  try {
    const segments = prepare('SELECT * FROM canal_segments ORDER BY order_index').all();
    if (segments.length === 0) return 2.5;
    const seg = segments.find(s => s.id === gate.canal_segment_id);
    if (seg) {
      return seg.design_water_level * 0.7;
    }
    return 2.5;
  } catch (e) {
    return 2.5;
  }
}

function addUsageRecord(irrigationId, irrigationName, dateStr, hour, volume, source) {
  const now = Date.now();
  const result = prepare(`
    INSERT INTO billing_usage_records 
    (irrigation_id, irrigation_name, record_date, record_hour, volume, source, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(irrigationId, irrigationName, dateStr, hour || 0, volume, source || 'manual', now);
  saveDatabase();
  return result.lastInsertRowid;
}

function getIrrigationMonthlyUsage(irrigationId, monthStr) {
  const month = monthStr || getMonthStr();
  const yearMonthPrefix = month.substring(0, 7);

  const records = prepare(`
    SELECT * FROM billing_usage_records 
    WHERE irrigation_id = ? AND substr(record_date, 1, 7) = ?
    ORDER BY record_date ASC, record_hour ASC
  `).all(irrigationId, yearMonthPrefix);

  const dailyMap = {};
  let totalVolume = 0;

  for (const r of records) {
    if (!dailyMap[r.record_date]) {
      dailyMap[r.record_date] = {
        date: r.record_date,
        total_volume: 0,
        hourly: {}
      };
    }
    dailyMap[r.record_date].total_volume += r.volume;
    dailyMap[r.record_date].hourly[r.record_hour] =
      (dailyMap[r.record_date].hourly[r.record_hour] || 0) + r.volume;
    totalVolume += r.volume;
  }

  const dailyList = Object.values(dailyMap).map(d => ({
    date: d.date,
    total_volume: Math.round(d.total_volume * 10000) / 10000,
    hourly: d.hourly
  }));

  const irrigation = prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(irrigationId);

  return {
    irrigation_id: irrigationId,
    irrigation_name: irrigation ? irrigation.name : null,
    month: month,
    total_volume: Math.round(totalVolume * 10000) / 10000,
    daily: dailyList
  };
}

function getAllIrrigationsUsageSummary(monthStr) {
  const month = monthStr || getMonthStr();
  const yearMonthPrefix = month.substring(0, 7);

  const records = prepare(`
    SELECT irrigation_id, irrigation_name, SUM(volume) as total_volume
    FROM billing_usage_records 
    WHERE substr(record_date, 1, 7) = ?
    GROUP BY irrigation_id
    ORDER BY total_volume DESC
  `).all(yearMonthPrefix);

  const irrigations = prepare('SELECT * FROM dispatch_irrigations').all();
  const irrigMap = {};
  for (const i of irrigations) irrigMap[i.id] = i;

  const result = records.map(r => ({
    irrigation_id: r.irrigation_id,
    irrigation_name: r.irrigation_name || (irrigMap[r.irrigation_id] ? irrigMap[r.irrigation_id].name : null),
    total_volume: Math.round(r.total_volume * 10000) / 10000,
    daily_quota: irrigMap[r.irrigation_id] ? irrigMap[r.irrigation_id].daily_quota : null
  }));

  const withAll = [...result];
  for (const irr of irrigations) {
    if (!withAll.find(r => r.irrigation_id === irr.id)) {
      withAll.push({
        irrigation_id: irr.id,
        irrigation_name: irr.name,
        total_volume: 0,
        daily_quota: irr.daily_quota
      });
    }
  }

  withAll.sort((a, b) => b.total_volume - a.total_volume);

  return {
    month: month,
    total_irrigations: withAll.length,
    ranking: withAll.map((r, idx) => ({ ...r, rank: idx + 1 }))
  };
}

function calculateTieredBilling(totalVolume, tariff) {
  if (!tariff || !tariff.tiers || tariff.tiers.length === 0) {
    return {
      quota_volume: 0,
      excess_volume: totalVolume,
      quota_amount: 0,
      excess_amount: 0,
      total_amount: 0,
      tier_details: []
    };
  }

  const tiers = [...tariff.tiers].sort((a, b) => a.tier_index - b.tier_index);
  let remaining = totalVolume;
  let totalAmount = 0;
  let quotaVolume = 0;
  let excessVolume = 0;
  let quotaAmount = 0;
  let excessAmount = 0;
  const tierDetails = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const tierStart = tier.start_volume || 0;
    const tierEnd = tier.end_volume;
    const unitPrice = tier.unit_price;

    let tierUsage = 0;
    let tierCost = 0;

    if (remaining <= 0) {
      tierDetails.push({
        tier_index: i,
        start_volume: tierStart,
        end_volume: tierEnd,
        unit_price: unitPrice,
        usage: 0,
        cost: 0
      });
      continue;
    }

    if (tierEnd === null || tierEnd === undefined) {
      tierUsage = remaining;
    } else {
      const tierRange = tierEnd - tierStart;
      tierUsage = Math.min(remaining, tierRange);
    }

    tierCost = tierUsage * unitPrice;
    totalAmount += tierCost;
    remaining -= tierUsage;

    if (i === 0) {
      quotaVolume += tierUsage;
      quotaAmount += tierCost;
    } else {
      excessVolume += tierUsage;
      excessAmount += tierCost;
    }

    tierDetails.push({
      tier_index: i,
      start_volume: tierStart,
      end_volume: tierEnd,
      unit_price: unitPrice,
      usage: Math.round(tierUsage * 10000) / 10000,
      cost: Math.round(tierCost * 10000) / 10000
    });
  }

  return {
    quota_volume: Math.round(quotaVolume * 10000) / 10000,
    excess_volume: Math.round(excessVolume * 10000) / 10000,
    quota_amount: Math.round(quotaAmount * 10000) / 10000,
    excess_amount: Math.round(excessAmount * 10000) / 10000,
    total_amount: Math.round(totalAmount * 10000) / 10000,
    tier_details: tierDetails
  };
}

function generateMonthlyBills(monthStr) {
  const month = monthStr || getMonthStr();
  const now = Date.now();
  const dueDate = new Date(month + '-01');
  dueDate.setMonth(dueDate.getMonth() + 1);
  dueDate.setDate(1);
  const dueAt = dueDate.getTime();

  const tariff = getTariffForMonth(month);
  if (!tariff) {
    throw new Error('未找到生效的水价方案');
  }

  const irrigations = prepare('SELECT * FROM dispatch_irrigations').all();
  const generatedBills = [];

  for (const irrig of irrigations) {
    const usage = getIrrigationMonthlyUsage(irrig.id, month);
    const billing = calculateTieredBilling(usage.total_volume, tariff);

    const existing = prepare(`
      SELECT * FROM billing_bills 
      WHERE irrigation_id = ? AND billing_month = ?
    `).get(irrig.id, month);

    if (existing) {
      if (existing.status === 'paid') {
        generatedBills.push(getBillWithDetails(existing.id));
        continue;
      }
      prepare(`
        UPDATE billing_bills SET
          total_volume = ?,
          quota_volume = ?,
          excess_volume = ?,
          quota_amount = ?,
          excess_amount = ?,
          total_amount = ?,
          tariff_snapshot = ?,
          tier_details = ?,
          generated_at = ?
        WHERE id = ?
      `).run(
        billing.quota_volume + billing.excess_volume,
        billing.quota_volume,
        billing.excess_volume,
        billing.quota_amount,
        billing.excess_amount,
        billing.total_amount,
        JSON.stringify(tariff),
        JSON.stringify(billing.tier_details),
        now,
        existing.id
      );
      generatedBills.push(getBillWithDetails(existing.id));
    } else {
      const result = prepare(`
        INSERT INTO billing_bills
        (irrigation_id, irrigation_name, billing_month, total_volume, quota_volume, excess_volume,
         quota_amount, excess_amount, total_amount, status, tariff_snapshot, tier_details,
         generated_at, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        irrig.id,
        irrig.name,
        month,
        billing.quota_volume + billing.excess_volume,
        billing.quota_volume,
        billing.excess_volume,
        billing.quota_amount,
        billing.excess_amount,
        billing.total_amount,
        JSON.stringify(tariff),
        JSON.stringify(billing.tier_details),
        now,
        dueAt
      );
      generatedBills.push(getBillWithDetails(result.lastInsertRowid));
    }
  }

  saveDatabase();
  updateOverdueStatus();
  return generatedBills;
}

function getBillWithDetails(billId) {
  const bill = prepare('SELECT * FROM billing_bills WHERE id = ?').get(billId);
  if (!bill) return null;

  return {
    ...bill,
    status: bill.status,
    tariff_snapshot: bill.tariff_snapshot ? JSON.parse(bill.tariff_snapshot) : null,
    tier_details: bill.tier_details ? JSON.parse(bill.tier_details) : []
  };
}

function queryBills(filters) {
  const conditions = [];
  const params = [];

  if (filters.month) {
    conditions.push('billing_month = ?');
    params.push(filters.month.substring(0, 7));
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.irrigationId) {
    conditions.push('irrigation_id = ?');
    params.push(parseInt(filters.irrigationId));
  }

  let sql = 'SELECT * FROM billing_bills';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY billing_month DESC, irrigation_id ASC';

  const bills = prepare(sql).all(...params);

  return bills.map(b => ({
    ...b,
    tariff_snapshot: b.tariff_snapshot ? JSON.parse(b.tariff_snapshot) : null,
    tier_details: b.tier_details ? JSON.parse(b.tier_details) : []
  }));
}

function payBill(billId) {
  const now = Date.now();
  const bill = prepare('SELECT * FROM billing_bills WHERE id = ?').get(billId);
  if (!bill) return null;
  if (bill.status === 'paid') return getBillWithDetails(billId);

  prepare(`
    UPDATE billing_bills SET status = 'paid', paid_at = ? WHERE id = ?
  `).run(now, billId);

  saveDatabase();
  return getBillWithDetails(billId);
}

function updateOverdueStatus() {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

  prepare(`
    UPDATE billing_bills 
    SET status = 'overdue' 
    WHERE status = 'pending' AND generated_at < ?
  `).run(thirtyDaysAgo);

  saveDatabase();
}

function getOverdueBills() {
  updateOverdueStatus();
  const bills = prepare(`
    SELECT * FROM billing_bills 
    WHERE status = 'overdue'
    ORDER BY generated_at ASC
  `).all();

  return bills.map(b => ({
    ...b,
    tariff_snapshot: b.tariff_snapshot ? JSON.parse(b.tariff_snapshot) : null,
    tier_details: b.tier_details ? JSON.parse(b.tier_details) : [],
    overdue_days: Math.floor((Date.now() - b.generated_at) / (24 * 3600 * 1000))
  }));
}

function getRestrictedIrrigations() {
  const overdue = getOverdueBills();
  const restrictedMap = {};

  for (const bill of overdue) {
    if (!restrictedMap[bill.irrigation_id]) {
      restrictedMap[bill.irrigation_id] = {
        irrigation_id: bill.irrigation_id,
        irrigation_name: bill.irrigation_name,
        restricted: true,
        reason: [],
        overdue_bills: [],
        max_flow_reduction: 0.5
      };
    }
    restrictedMap[bill.irrigation_id].reason.push(
      `${bill.billing_month}月账单逾期 ${bill.overdue_days} 天，欠费 ${bill.total_amount} 元`
    );
    restrictedMap[bill.irrigation_id].overdue_bills.push({
      bill_id: bill.id,
      billing_month: bill.billing_month,
      total_amount: bill.total_amount,
      overdue_days: bill.overdue_days
    });
  }

  return Object.values(restrictedMap);
}

function isIrrigationRestricted(irrigationId) {
  const restricted = getRestrictedIrrigations();
  return restricted.some(r => r.irrigation_id === irrigationId);
}

function getRestrictedIdsSet() {
  const restricted = getRestrictedIrrigations();
  return new Set(restricted.map(r => r.irrigation_id));
}

let hourlyTimer = null;

function startHourlyAggregation() {
  if (hourlyTimer) return;
  hourlyTimer = setInterval(() => {
    try {
      accumulateHourlyUsage();
    } catch (err) {
      console.error('Hourly usage aggregation error:', err);
    }
  }, 3600 * 1000);
  console.log('每小时用水量自动汇总已启动');
}

function stopHourlyAggregation() {
  if (hourlyTimer) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
}

function initBillingDemoData() {
  const existingTariffs = prepare('SELECT COUNT(*) as count FROM billing_tariffs').get();
  if (!existingTariffs || existingTariffs.count === 0) {
    const now = Date.now();
    const today = getTodayStr();

    const result = prepare(`
      INSERT INTO billing_tariffs (name, effective_date, is_active, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).run('默认阶梯水价方案', today, now, now);

    const tariffId = result.lastInsertRowid;

    prepare(`
      INSERT INTO billing_tariff_tiers (tariff_id, tier_index, start_volume, end_volume, unit_price)
      VALUES (?, 0, 0, 2000, 0.5)
    `).run(tariffId);

    prepare(`
      INSERT INTO billing_tariff_tiers (tariff_id, tier_index, start_volume, end_volume, unit_price)
      VALUES (?, 1, 2000, NULL, 1.2)
    `).run(tariffId);

    saveDatabase();
    console.log('预置水价方案已初始化: 配额内0.5元/m³,超额1.2元/m³');
  }

  const existingUsage = prepare('SELECT COUNT(*) as count FROM billing_usage_records').get();
  if (!existingUsage || existingUsage.count === 0) {
    const today = getTodayStr();
    const monthPrefix = today.substring(0, 7);

    const irrigations = prepare('SELECT * FROM dispatch_irrigations ORDER BY id ASC').all();
    const demoVolumes = { '灌区A': 3000, '灌区B': 2500, '灌区C': 1800 };

    for (const irrig of irrigations) {
      const totalVolume = demoVolumes[irrig.name] || 1000;
      const todayDay = new Date().getDate();
      const daysToGenerate = Math.max(1, Math.min(todayDay, Math.ceil(totalVolume / 200)));

      const perDay = Math.ceil(totalVolume / daysToGenerate);
      let remaining = totalVolume;

      for (let day = 1; day <= daysToGenerate && remaining > 0; day++) {
        const dateStr = monthPrefix + '-' + String(day).padStart(2, '0');
        const dayPortion = Math.min(remaining, perDay);
        remaining -= dayPortion;

        const perHour = Math.max(1, Math.floor(dayPortion / 12));
        let dayRemaining = dayPortion;
        for (let h = 8; h < 20 && dayRemaining > 0; h++) {
          const hourPortion = (h === 19) ? dayRemaining : perHour;
          dayRemaining -= hourPortion;
          addUsageRecord(irrig.id, irrig.name, dateStr, h, hourPortion, 'demo');
        }
      }
    }

    console.log('预置模拟用水数据已初始化: 灌区A 3000m³, 灌区B 2500m³, 灌区C 1800m³');
  }

  saveDatabase();
}

module.exports = {
  createTariff,
  getAllTariffs,
  getCurrentTariff,
  getTariffWithTiers,
  getTariffForMonth,
  accumulateHourlyUsage,
  addUsageRecord,
  getIrrigationMonthlyUsage,
  getAllIrrigationsUsageSummary,
  calculateTieredBilling,
  generateMonthlyBills,
  getBillWithDetails,
  queryBills,
  payBill,
  updateOverdueStatus,
  getOverdueBills,
  getRestrictedIrrigations,
  isIrrigationRestricted,
  getRestrictedIdsSet,
  startHourlyAggregation,
  stopHourlyAggregation,
  initBillingDemoData
};
