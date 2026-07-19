import express from 'express';
import pool from '../shared/db.js';

const router = express.Router();

router.get('/deliveries', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM delivery_orders ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/deliveries', async (req, res) => {
  try {
    const { order_id, delivery_date, address, status } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO delivery_orders (order_id, delivery_date, address, status)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [order_id, delivery_date, address, status || 'pending']
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/credit', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM credit_notes ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/credit', async (req, res) => {
  try {
    const { order_id, amount, reason } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO credit_notes (order_id, amount, reason) VALUES ($1,$2,$3) RETURNING *`,
      [order_id, amount, reason]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
