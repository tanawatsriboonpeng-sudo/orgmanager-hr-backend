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
    // Older databases were created before departments.manager_id was added
    // to migrate.js, so add it defensively here too.
    await client.query(`
      ALTER TABLE departments
      ADD COLUMN IF NOT EXISTS manager_id UUID
    `);
    await client.query(`
      ALTER TABLE departments
      ADD COLUMN IF NOT EXISTS description TEXT
    `);
    // Per-day shift overrides. Each row is one employee on one date.
    // Falls back to employees.shift_type when no row exists for a given day.
    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        shift_type VARCHAR(20) NOT NULL CHECK (shift_type IN ('normal','flexible','dayoff')),
        notes TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, date)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shift_assignments_date ON shift_assignments(date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shift_assignments_employee_date ON shift_assignments(employee_id, date)
    `);
    // shift_configs may not exist on legacy databases that were created
    // before this table was added to migrate.js. Create it defensively.
    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        shift_type VARCHAR(20) NOT NULL,
        description TEXT,
        work_days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
        checkin_start TIME NOT NULL DEFAULT '08:30',
        checkin_end TIME NOT NULL DEFAULT '10:00',
        work_start TIME NOT NULL DEFAULT '09:00',
        work_end TIME NOT NULL DEFAULT '17:00',
        grace_minutes INT DEFAULT 0,
        late_warning_minutes INT DEFAULT 1,
        late_threshold_minutes INT DEFAULT 10,
        absent_threshold_minutes INT DEFAULT 20,
        flex_tiers JSONB DEFAULT '[]'::jsonb,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // late_warning_minutes = how many minutes after work_start counts as
    // "เกือบสาย" (between grace_minutes and late_threshold_minutes).
    // flex_tiers = JSON array of {checkin_until: "HH:MM", checkout: "HH:MM"}
    // describing the staggered flexible-shift schedule.
    await client.query(`
      ALTER TABLE shift_configs
      ADD COLUMN IF NOT EXISTS late_warning_minutes INT DEFAULT 1
    `);
    await client.query(`
      ALTER TABLE shift_configs
      ADD COLUMN IF NOT EXISTS flex_tiers JSONB DEFAULT '[]'::jsonb
    `);
    await client.query(`
      ALTER TABLE shift_configs
      ADD COLUMN IF NOT EXISTS description TEXT
    `);
    // Human-friendly code (e.g. "WC001") so HR can pick "WC001" / "WC002"
    // on the weekly grid the way HumanSoft does. Unique, nullable for
    // legacy rows.
    await client.query(`
      ALTER TABLE shift_configs
      ADD COLUMN IF NOT EXISTS code VARCHAR(20)
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shift_configs_code_unique'
        ) THEN
          ALTER TABLE shift_configs ADD CONSTRAINT shift_configs_code_unique UNIQUE (code);
        END IF;
      END $$;
    `);
    // The old CHECK constraint on shift_assignments.shift_type pinned us
    // to ('normal','flexible','dayoff'). Drop it so a cell can now store
    // any shift_configs.code value.
    await client.query(`
      ALTER TABLE shift_assignments
      DROP CONSTRAINT IF EXISTS shift_assignments_shift_type_check
    `);
    console.log('🔧 schema check ok');
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
