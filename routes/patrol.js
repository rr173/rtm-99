const express = require('express');
const router = express.Router();
const patrolService = require('../services/patrolService');

router.post('/routes', (req, res) => {
  try {
    const { name, estimatedDurationMinutes, checkpoints } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name 路线名称不能为空' });
    }
    if (!estimatedDurationMinutes) {
      return res.status(400).json({ error: 'estimatedDurationMinutes 预计耗时(分钟)不能为空' });
    }
    if (!checkpoints || !Array.isArray(checkpoints)) {
      return res.status(400).json({ error: 'checkpoints 巡检点数组不能为空' });
    }

    const route = patrolService.createRoute(name, estimatedDurationMinutes, checkpoints);
    res.json({
      success: true,
      route: route
    });
  } catch (err) {
    console.error('Create route error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/routes', (req, res) => {
  try {
    const routes = patrolService.getRouteList();
    res.json({
      total: routes.length,
      routes: routes
    });
  } catch (err) {
    console.error('Get routes error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/routes/:id', (req, res) => {
  try {
    const { id } = req.params;
    const route = patrolService.getRouteDetail(parseInt(id));
    
    if (!route) {
      return res.status(404).json({ error: '路线不存在' });
    }
    
    res.json(route);
  } catch (err) {
    console.error('Get route detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks', (req, res) => {
  try {
    const { routeId, inspectorName, plannedStartTime } = req.body;

    if (!routeId) {
      return res.status(400).json({ error: 'routeId 路线ID不能为空' });
    }
    if (!inspectorName) {
      return res.status(400).json({ error: 'inspectorName 巡检员姓名不能为空' });
    }
    if (!plannedStartTime) {
      return res.status(400).json({ error: 'plannedStartTime 计划开始时间(时间戳)不能为空' });
    }

    const task = patrolService.createTask(
      parseInt(routeId),
      inspectorName,
      parseInt(plannedStartTime)
    );
    
    res.json({
      success: true,
      task: task
    });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const task = patrolService.getTaskDetail(parseInt(id));
    
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    
    res.json(task);
  } catch (err) {
    console.error('Get task detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/tracks', (req, res) => {
  try {
    const { taskId, latitude, longitude, timestamp } = req.body;

    if (!taskId) {
      return res.status(400).json({ error: 'taskId 任务ID不能为空' });
    }
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'latitude/longitude 经纬度不能为空' });
    }
    if (!timestamp) {
      return res.status(400).json({ error: 'timestamp 时间戳不能为空' });
    }

    const result = patrolService.reportTrack(
      parseInt(taskId),
      parseFloat(latitude),
      parseFloat(longitude),
      parseInt(timestamp)
    );
    
    res.json(result);
  } catch (err) {
    console.error('Report track error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/anomalies', (req, res) => {
  try {
    const { taskId, latitude, longitude, type, description, severity } = req.body;

    if (!taskId) {
      return res.status(400).json({ error: 'taskId 任务ID不能为空' });
    }
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'latitude/longitude 经纬度不能为空' });
    }
    if (!type) {
      return res.status(400).json({ error: 'type 异常类型不能为空' });
    }
    if (!severity) {
      return res.status(400).json({ error: 'severity 严重程度不能为空' });
    }

    const anomaly = patrolService.reportAnomaly(
      parseInt(taskId),
      parseFloat(latitude),
      parseFloat(longitude),
      type,
      description,
      severity
    );
    
    res.json({
      success: true,
      anomaly: anomaly
    });
  } catch (err) {
    console.error('Report anomaly error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/anomalies', (req, res) => {
  try {
    const { type, severity, segmentId, startTime, endTime } = req.query;
    const filters = {};
    
    if (type) filters.type = type;
    if (severity) filters.severity = severity;
    if (segmentId) filters.segmentId = segmentId;
    if (startTime) filters.startTime = parseInt(startTime);
    if (endTime) filters.endTime = parseInt(endTime);

    const result = patrolService.getAnomalyList(filters);
    res.json(result);
  } catch (err) {
    console.error('Get anomalies error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/anomalies/stats', (req, res) => {
  try {
    const stats = patrolService.getAnomalyStats();
    res.json(stats);
  } catch (err) {
    console.error('Get anomaly stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
