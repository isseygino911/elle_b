const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', timestamp, db: 'ok' });
  } catch (err) {
    console.error('Health check DB query failed:', err);
    res.status(503).json({
      status: 'error',
      timestamp,
      db: 'error',
      message: 'Database connection failed'
    });
  }
});

module.exports = router;
