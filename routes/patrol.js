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

router.get('/tasks', (req, res) => {
  try {
    const tasks = patrolService.getTaskList();
    res.json({
      total: tasks.length,
      tasks: tasks
    });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: err.message });
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

router.post('/reports', (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ error: 'taskId 任务ID不能为空' });
    }

    const report = patrolService.generateReport(parseInt(taskId));
    res.json(report);
  } catch (err) {
    console.error('Generate report error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/reports/summary', (req, res) => {
  try {
    const summary = patrolService.getReportSummary();
    res.json(summary);
  } catch (err) {
    console.error('Get report summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/:taskId', (req, res) => {
  try {
    const { taskId } = req.params;
    const report = patrolService.getReportDetailByTaskId(parseInt(taskId));
    
    if (!report) {
      return res.status(404).json({ error: '报告不存在' });
    }
    
    res.json(report);
  } catch (err) {
    console.error('Get report detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports', (req, res) => {
  try {
    const { inspectorName, startTime, endTime, minScore, maxScore } = req.query;
    const filters = {};
    
    if (inspectorName) filters.inspectorName = inspectorName;
    if (startTime) filters.startTime = startTime;
    if (endTime) filters.endTime = endTime;
    if (minScore !== undefined) filters.minScore = minScore;
    if (maxScore !== undefined) filters.maxScore = maxScore;

    const result = patrolService.getReportList(filters);
    res.json(result);
  } catch (err) {
    console.error('Get reports error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/work-orders/assign', (req, res) => {
  try {
    const { workOrderIds, handlerName, assignedBy } = req.body;

    if (!workOrderIds || !Array.isArray(workOrderIds)) {
      return res.status(400).json({ error: 'workOrderIds 工单ID数组不能为空' });
    }
    if (!handlerName) {
      return res.status(400).json({ error: 'handlerName 处理人姓名不能为空' });
    }

    const result = patrolService.assignWorkOrders(workOrderIds, handlerName, assignedBy);
    res.json({
      success: true,
      assigned_count: result.assigned.length,
      failed_count: result.failed.length,
      assigned: result.assigned,
      failed: result.failed
    });
  } catch (err) {
    console.error('Assign work orders error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/work-orders', (req, res) => {
  try {
    const { status, handlerName, anomalyType, segmentId, startTime, endTime } = req.query;
    const filters = {};

    if (status) filters.status = status;
    if (handlerName) filters.handlerName = handlerName;
    if (anomalyType) filters.anomalyType = anomalyType;
    if (segmentId) filters.segmentId = segmentId;
    if (startTime) filters.startTime = startTime;
    if (endTime) filters.endTime = endTime;

    const result = patrolService.getWorkOrderList(filters);
    res.json(result);
  } catch (err) {
    console.error('Get work orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/work-orders/overdue', (req, res) => {
  try {
    const result = patrolService.getOverdueWorkOrders();
    res.json(result);
  } catch (err) {
    console.error('Get overdue work orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/work-orders/dashboard', (req, res) => {
  try {
    const result = patrolService.getWorkOrderDashboard();
    res.json(result);
  } catch (err) {
    console.error('Get work order dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/work-orders/:id/timeline', (req, res) => {
  try {
    const { id } = req.params;
    const result = patrolService.getWorkOrderTimeline(parseInt(id));
    res.json(result);
  } catch (err) {
    console.error('Get work order timeline error:', err);
    res.status(404).json({ error: err.message });
  }
});

router.put('/work-orders/:id/process', (req, res) => {
  try {
    const { id } = req.params;
    const { description, measures, operator } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'description 处理描述不能为空' });
    }
    if (!measures) {
      return res.status(400).json({ error: 'measures 处理措施不能为空' });
    }

    const result = patrolService.processWorkOrder(parseInt(id), description, measures, operator);
    res.json({
      success: true,
      work_order: result
    });
  } catch (err) {
    console.error('Process work order error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/work-orders/:id/verify', (req, res) => {
  try {
    const { id } = req.params;
    const { result: verifyResult, opinion, operator } = req.body;

    if (!verifyResult || (verifyResult !== 'pass' && verifyResult !== 'reject')) {
      return res.status(400).json({ error: 'result 验收结果必须是 pass 或 reject' });
    }

    const result = patrolService.verifyWorkOrder(parseInt(id), verifyResult, opinion, operator);
    res.json({
      success: true,
      work_order: result
    });
  } catch (err) {
    console.error('Verify work order error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/work-orders/:id/reprocess', (req, res) => {
  try {
    const { id } = req.params;
    const { description, measures, operator } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'description 处理描述不能为空' });
    }
    if (!measures) {
      return res.status(400).json({ error: 'measures 处理措施不能为空' });
    }

    const result = patrolService.reprocessWorkOrder(parseInt(id), description, measures, operator);
    res.json({
      success: true,
      work_order: result
    });
  } catch (err) {
    console.error('Reprocess work order error:', err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
