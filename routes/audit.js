const express = require('express');
const router = express.Router();
const auditService = require('../services/auditService');

router.get('/logs', (req, res) => {
  try {
    const { type, operator, target, startTime, endTime, page, pageSize } = req.query;
    const result = auditService.queryLogs({
      type,
      operator,
      target,
      startTime,
      endTime,
      page,
      pageSize
    });
    res.json(result);
  } catch (err) {
    console.error('查询审计日志失败:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:id', (req, res) => {
  try {
    const { id } = req.params;
    const log = auditService.getLogById(id);
    if (!log) {
      return res.status(404).json({ error: '日志不存在' });
    }
    res.json(log);
  } catch (err) {
    console.error('获取审计日志详情失败:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', (req, res) => {
  try {
    const { startTime, endTime } = req.query;
    const summary = auditService.getSummary(startTime, endTime);
    res.json(summary);
  } catch (err) {
    console.error('获取审计统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trail/:targetId', (req, res) => {
  try {
    const { targetId } = req.params;
    const trail = auditService.getTargetTrail(targetId);
    res.json({
      targetId,
      total: trail.length,
      trail
    });
  } catch (err) {
    console.error('获取操作轨迹失败:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/report', (req, res) => {
  try {
    const { startTime, endTime } = req.query;
    const report = auditService.getAuditReport(startTime, endTime);
    res.json(report);
  } catch (err) {
    console.error('生成审计报告失败:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
