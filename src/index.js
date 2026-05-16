require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const routes = require('./routes');
const { pool } = require('../config/database');

const app = express();
const PORT = process.env.PORT || 3001;

// Self-healing schema migrations. Each statement is idempotent
// (IF NOT EXISTS / IF EXISTS) so this is safe to run on every boot
// and keeps deployed environments in sync without a manual step.
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id)
    `);
    console.log('🔧 schema check ok (manager_id ensured)');
  } catch (e) {
    console.error('⚠️  schema check failed:', e.message);
  } finally {
    client.release();
  }
}

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const generalLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200 });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

app.use('/api/auth', authLimiter);
app.use('/api', generalLimiter);
app.use('/api', routes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: `ไม่พบ endpoint: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบ' });
});

app.listen(PORT, async () => {
  console.log(`🚀 OrgManager HR API - Port: ${PORT}`);
  await ensureSchema();
});

module.exports = app;
