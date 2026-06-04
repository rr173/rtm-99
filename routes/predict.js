const express = require('express');
const router = express.Router();
const { prepare } = require('../db');
const predictionService = require('../services/predictionService');

router.post('/', (req, res) => {
  try {
    const { adjustments } = req.body;
    
    if (!Array.isArray(adjustments)) {
      return res.status(400).json({ error: 'adjustments 必须是数组' });
    }
    
    for (let i = 0; i < adjustments.length; i++) {
      const adj = adjustments[i];
      if (!adj.gateId || adj.newOpening === undefined) {
        return res.status(400).json({ error: `第${i + 1}条调整指令缺少必要字段` });
      }
      const gate = prepare('SELECT * FROM gates WHERE id = ?').get(adj.gateId);
      if (!gate) {
        return res.status(404).json({ error: `闸门不存在: ${adj.gateId}` });
      }
      if (adj.newOpening < 0 || adj.newOpening > gate.max_opening) {
        return res.status(400).json({ 
          error: `闸门 ${gate.name} 开度必须在 0 到 ${gate.max_opening} 之间` 
        });
      }
    }
    
    const result = predictionService.predictWaterLevels(adjustments);
    
    if (result.computeTimeMs > 3000) {
      console.warn(`预测计算耗时过长: ${result.computeTimeMs}ms`);
    }
    
    res.json(result);
  } catch (err) {
    console.error('Prediction error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
