const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const maintenanceService = require('../services/maintenanceService');

router.post('/plans', (req, res) => {
  try {
    const { segmentId, planStartTime, durationHours, maintenanceType, responsiblePerson, notes } = req.body;
    
    if (!segmentId) {
      return res.status(400).json({ error: 'segmentId 渠段ID不能为空' });
    }
    if (!planStartTime) {
      return res.status(400).json({ error: 'planStartTime 计划开始时间不能为空(时间戳)' });
    }
    if (!durationHours || isNaN(parseFloat(durationHours)) || parseFloat(durationHours) <= 0) {
      return res.status(400).json({ error: 'durationHours 预计时长必须是正数(小时)' });
    }
    if (!maintenanceType) {
      return res.status(400).json({ error: 'maintenanceType 维护类型不能为空' });
    }
    if (!maintenanceService.MAINTENANCE_TYPES.includes(maintenanceType)) {
      return res.status(400).json({ 
        error: 'maintenanceType 维护类型必须是: ' + maintenanceService.MAINTENANCE_TYPES.join(', '),
        valid_types: maintenanceService.MAINTENANCE_TYPES.map(t => ({
          code: t,
          name: maintenanceService.MAINTENANCE_TYPE_NAMES[t]
        }))
      });
    }
    
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
    if (!seg) {
      return res.status(404).json({ error: '渠段不存在: ' + segmentId });
    }
    
    const plan = maintenanceService.createMaintenancePlan({
      segmentId,
      planStartTime,
      durationHours,
      maintenanceType,
      responsiblePerson,
      notes
    });
    
    res.json({
      success: true,
      message: '维护计划创建成功',
      plan: plan
    });
  } catch (err) {
    console.error('Create maintenance plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/plans', (req, res) => {
  try {
    const { status, segmentId } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (segmentId) filters.segmentId = segmentId;
    
    const plans = maintenanceService.getMaintenancePlans(filters);
    
    res.json({
      total: plans.length,
      plans: plans
    });
  } catch (err) {
    console.error('Get maintenance plans error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/plans/:id', (req, res) => {
  try {
    const { id } = req.params;
    const plan = maintenanceService.getMaintenancePlan(id);
    
    if (!plan) {
      return res.status(404).json({ error: '维护计划不存在' });
    }
    
    res.json(plan);
  } catch (err) {
    console.error('Get maintenance plan detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id/cancel', (req, res) => {
  try {
    const { id } = req.params;
    const result = maintenanceService.cancelMaintenancePlan(id);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      message: '维护计划已取消',
      plan: result
    });
  } catch (err) {
    console.error('Cancel maintenance plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id/start', (req, res) => {
  try {
    const { id } = req.params;
    const result = maintenanceService.startMaintenancePlan(id);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
  } catch (err) {
    console.error('Start maintenance plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id/complete', (req, res) => {
  try {
    const { id } = req.params;
    const result = maintenanceService.completeMaintenancePlan(id);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json(result);
  } catch (err) {
    console.error('Complete maintenance plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/impact/:segmentId', (req, res) => {
  try {
    const { segmentId } = req.params;
    const { durationHours } = req.query;
    
    const seg = prepare('SELECT * FROM canal_segments WHERE id = ?').get(segmentId);
    if (!seg) {
      return res.status(404).json({ error: '渠段不存在: ' + segmentId });
    }
    
    const duration = durationHours ? parseFloat(durationHours) : 8;
    if (isNaN(duration) || duration <= 0) {
      return res.status(400).json({ error: 'durationHours 必须是正数(小时)' });
    }
    
    const impactAssessment = maintenanceService.calculateImpactAssessment(segmentId, duration);
    const alternativeSupply = maintenanceService.calculateAlternativeSupply(impactAssessment);
    const bestWindow = maintenanceService.findBestMaintenanceWindow(segmentId, duration);
    
    res.json({
      segment_id: segmentId,
      segment_name: seg.name,
      duration_hours: duration,
      impact_assessment: impactAssessment,
      alternative_supply: alternativeSupply,
      suggested_maintenance_window: bestWindow
    });
  } catch (err) {
    console.error('Get maintenance impact error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
