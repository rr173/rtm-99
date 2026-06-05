const express = require('express');
const router = express.Router();
const emergencyService = require('../services/emergencyService');

router.post('/plans', (req, res) => {
  try {
    const plan = emergencyService.createPlan(req.body);
    res.json({
      success: true,
      message: '预案创建成功',
      plan
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/plans', (req, res) => {
  try {
    const plans = emergencyService.getAllPlans();
    res.json({
      total: plans.length,
      plans
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const plan = emergencyService.getPlanById(parseInt(id));
    if (!plan) {
      return res.status(404).json({ error: '预案不存在' });
    }
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const plan = emergencyService.updatePlan(parseInt(id), req.body);
    res.json({
      success: true,
      message: '预案更新成功',
      plan
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/plans/:id', (req, res) => {
  try {
    const { id } = req.params;
    emergencyService.deletePlan(parseInt(id));
    res.json({
      success: true,
      message: '预案删除成功'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/check', (req, res) => {
  try {
    const result = emergencyService.checkAllPlans();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/simulate/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const result = await emergencyService.simulatePlan(parseInt(planId));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/execute/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const result = await emergencyService.executePlan(parseInt(planId));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/executions', (req, res) => {
  try {
    const executions = emergencyService.getExecutions();
    res.json({
      total: executions.length,
      executions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/executions/:id', (req, res) => {
  try {
    const { id } = req.params;
    const detail = emergencyService.getExecutionDetail(parseInt(id));
    if (!detail) {
      return res.status(404).json({ error: '执行记录不存在' });
    }
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
