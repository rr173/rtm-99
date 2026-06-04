const express = require('express');
const router = express.Router();
const conflictDetection = require('../services/conflictDetection');

router.get('/', (req, res) => {
  try {
    const result = conflictDetection.detectConflicts();
    res.json(result);
  } catch (err) {
    console.error('Conflict detection error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
