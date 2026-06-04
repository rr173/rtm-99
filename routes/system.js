const express = require('express');
const router = express.Router();
const conflictDetection = require('../services/conflictDetection');

router.get('/summary', (req, res) => {
  try {
    const summary = conflictDetection.getSystemSummary();
    res.json(summary);
  } catch (err) {
    console.error('System summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
