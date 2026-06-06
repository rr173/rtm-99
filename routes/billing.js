const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const billingService = require('../services/billingService');

router.post('/tariffs', (req, res) => {
  try {
    const { name, effective_date, tiers } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name 方案名不能为空' });
    }
    if (!effective_date) {
      return res.status(400).json({ error: 'effective_date 生效日期不能为空' });
    }
    if (!tiers || !Array.isArray(tiers) || tiers.length < 2) {
      return res.status(400).json({ error: 'tiers 阶梯档位列表至少需要两档' });
    }

    const tariff = billingService.createTariff({ name, effective_date, tiers });

    res.json({
      success: true,
      message: '水价方案创建成功',
      tariff: tariff
    });
  } catch (err) {
    console.error('Create tariff error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/tariffs', (req, res) => {
  try {
    const tariffs = billingService.getAllTariffs();
    res.json({
      total: tariffs.length,
      tariffs: tariffs
    });
  } catch (err) {
    console.error('Get tariffs error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/tariffs/current', (req, res) => {
  try {
    const tariff = billingService.getCurrentTariff();
    if (!tariff) {
      return res.status(404).json({ error: '当前没有生效的水价方案' });
    }
    res.json(tariff);
  } catch (err) {
    console.error('Get current tariff error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage/aggregate', (req, res) => {
  try {
    billingService.accumulateHourlyUsage();
    res.json({
      success: true,
      message: '用水量汇总已执行',
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Aggregate usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage/summary', (req, res) => {
  try {
    const { month } = req.query;
    const summary = billingService.getAllIrrigationsUsageSummary(month);
    res.json(summary);
  } catch (err) {
    console.error('Get usage summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage/:irrigationId', (req, res) => {
  try {
    const { irrigationId } = req.params;
    const { month } = req.query;

    const irrigation = prepare('SELECT * FROM dispatch_irrigations WHERE id = ?').get(parseInt(irrigationId));
    if (!irrigation) {
      return res.status(404).json({ error: '灌区不存在' });
    }

    const usage = billingService.getIrrigationMonthlyUsage(parseInt(irrigationId), month);
    res.json(usage);
  } catch (err) {
    console.error('Get irrigation usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', (req, res) => {
  try {
    const { month } = req.query;
    const bills = billingService.generateMonthlyBills(month);

    res.json({
      success: true,
      message: bills.length > 0 ? '账单生成成功' : '没有灌区可生成账单',
      generated_count: bills.length,
      bills: bills
    });
  } catch (err) {
    console.error('Generate bills error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/bills', (req, res) => {
  try {
    const { month, status, irrigationId } = req.query;
    const filters = {};
    if (month) filters.month = month;
    if (status) filters.status = status;
    if (irrigationId) filters.irrigationId = irrigationId;

    const bills = billingService.queryBills(filters);

    res.json({
      total: bills.length,
      bills: bills
    });
  } catch (err) {
    console.error('Query bills error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/bills/:id', (req, res) => {
  try {
    const { id } = req.params;
    const bill = billingService.getBillWithDetails(parseInt(id));

    if (!bill) {
      return res.status(404).json({ error: '账单不存在' });
    }

    res.json(bill);
  } catch (err) {
    console.error('Get bill detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/bills/:id/pay', (req, res) => {
  try {
    const { id } = req.params;
    const paid = billingService.payBill(parseInt(id));

    if (!paid) {
      return res.status(404).json({ error: '账单不存在' });
    }

    res.json({
      success: true,
      message: '账单已标记为已付款',
      bill: paid
    });
  } catch (err) {
    console.error('Pay bill error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/overdue', (req, res) => {
  try {
    const bills = billingService.getOverdueBills();
    res.json({
      total: bills.length,
      overdue_bills: bills
    });
  } catch (err) {
    console.error('Get overdue bills error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/restricted', (req, res) => {
  try {
    const restricted = billingService.getRestrictedIrrigations();
    res.json({
      total: restricted.length,
      restricted_irrigations: restricted
    });
  } catch (err) {
    console.error('Get restricted irrigations error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
