const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const stateManager = require('../services/stateManager');

router.post('/batch', (req, res) => {
  try {
    const { data } = req.body;
    
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: '数据格式错误，需要非空数组' });
    }
    
    const validData = [];
    const errors = [];
    
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      
      if (!item.pointId || item.waterLevel === undefined || !item.timestamp) {
        errors.push(`第${i + 1}条数据缺少必要字段`);
        continue;
      }
      
      const point = prepare('SELECT 1 FROM measurement_points WHERE id = ?').get(item.pointId);
      if (!point) {
        errors.push(`测点ID不存在: ${item.pointId}`);
        continue;
      }
      
      if (typeof item.waterLevel !== 'number' || item.waterLevel < -10 || item.waterLevel > 200) {
        errors.push(`水位值不合理: ${item.waterLevel}`);
        continue;
      }
      
      validData.push({
        pointId: item.pointId,
        waterLevel: item.waterLevel,
        timestamp: item.timestamp
      });
    }
    
    if (validData.length > 0) {
      stateManager.updateWaterLevelsBatch(validData);
    }
    
    res.json({
      success: true,
      received: data.length,
      processed: validData.length,
      errors: errors,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Batch telemetry error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:pointId/history', (req, res) => {
  try {
    const { pointId } = req.params;
    const { from, to } = req.query;
    
    const point = prepare('SELECT * FROM measurement_points WHERE id = ?').get(pointId);
    if (!point) {
      return res.status(404).json({ error: '测点不存在' });
    }
    
    let query = 'SELECT water_level, timestamp FROM water_level_history WHERE point_id = ?';
    const params = [pointId];
    
    if (from) {
      query += ' AND timestamp >= ?';
      params.push(parseInt(from));
    }
    if (to) {
      query += ' AND timestamp <= ?';
      params.push(parseInt(to));
    }
    
    query += ' ORDER BY timestamp DESC LIMIT 2000';
    
    const history = prepare(query).all(...params);
    
    const result = history.map(h => ({
      waterLevel: h.water_level,
      timestamp: h.timestamp
    })).reverse();
    
    res.json({
      pointId: pointId,
      pointName: point.name,
      segmentId: point.canal_segment_id,
      from: from ? parseInt(from) : (result.length > 0 ? result[0].timestamp : null),
      to: to ? parseInt(to) : (result.length > 0 ? result[result.length - 1].timestamp : null),
      count: result.length,
      data: result
    });
  } catch (err) {
    console.error('History query error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
