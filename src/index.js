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
    // employees.work_days lists weekday numbers (0=Sun, 1=Mon, ... 6=Sat)
    // that the employee is scheduled to work by default. Used by the
    // "วันทำงาน/วันหยุดพนักงาน" grid in /shifts.
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS work_days INTEGER[] DEFAULT ARRAY[1,2,3,4,5]
    `);
    // avatar_url was VARCHAR(500) in the original schema — too small for
    // base64 dataURLs (a resized photo is ~50–100KB / 50–100k chars).
    // Widen to TEXT so it can hold the dataURL we generate client-side.
    await client.query(`
      ALTER TABLE employees ALTER COLUMN avatar_url TYPE TEXT
    `).catch(() => {});
    // employees.weekly_shifts is the recurring weekly schedule. JSON shape:
    //   { "0": "dayoff", "1": "WC001", "2": "WC001", ..., "6": "dayoff" }
    // Keys are day-of-week numbers (0=Sun..6=Sat). Values are either a
    // shift_configs.code or the string "dayoff". Missing keys default to
    // "dayoff" on the frontend. Replaces the per-date shift_assignments
    // approach for the weekly grid.
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS weekly_shifts JSONB DEFAULT '{}'::jsonb
    `);
    // Position tree (โครงสร้างตำแหน่ง). Self-referential. Each row is one
    // position title (e.g. "ผู้จัดการ") with a code (e.g. "M0001") and an
    // optional parent. Frontend renders as a tree.
    await client.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(50) UNIQUE,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        parent_id UUID REFERENCES positions(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_parent ON positions(parent_id)
    `);
    // Comprehensive HumanSoft-style employee profile fields. Mostly
    // optional — the form lets owner/HR fill them in over time and the
    // employee themselves can self-edit a safe subset.
    const employeeColumns = [
      // Personal — names & demographics
      ['title',              'VARCHAR(50)'],   // คำนำหน้าชื่อ
      ['first_name_en',      'VARCHAR(100)'],
      ['last_name_en',       'VARCHAR(100)'],
      ['nickname_en',        'VARCHAR(50)'],
      ['gender',             'VARCHAR(20)'],   // male/female/other
      ['nationality',        'VARCHAR(50)'],   // ไทย/ต่างชาติ
      ['marital_status',     'VARCHAR(20)'],   // โสด/สมรส/หย่า/หม้าย
      ['date_of_birth',      'DATE'],
      ['address',            'TEXT'],          // ที่อยู่
      // ID documents (national_id already exists)
      ['passport_number',    'VARCHAR(50)'],
      ['social_security_number', 'VARCHAR(50)'],
      // Employment — legacy DBs may not have these even though they're
      // in migrate.js, so defensively add.
      ['start_date',         'DATE'],
      ['contract_end_date',  'DATE'],
      ['employment_type',    'VARCHAR(20)'],
      ['hire_date',          'DATE'],          // วันที่บรรจุ
      ['retirement_year',    'INT'],
      ['probation_days',     'INT'],
      ['probation_end_date', 'DATE'],
      ['fingerprint_code',   'VARCHAR(50)'],
      // Bank / payroll — legacy DBs may not have bank_account / bank_name
      ['bank_account',       'VARCHAR(50)'],
      ['bank_name',          'VARCHAR(100)'],
      ['bank_branch_code',   'VARCHAR(20)'],
      ['payment_method',     'VARCHAR(20)'],   // transfer/cash/cheque
      ['tax_id',             'VARCHAR(20)'],
      ['national_id',        'VARCHAR(20)'],
      // Free-form
      ['notes',              'TEXT'],
      ['hashtags',           'TEXT[]'],
    ];
    for (const [name, type] of employeeColumns) {
      await client.query(
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );
    }
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

// Loosened from 20→100 so legitimate users aren't locked out after a few
// typos plus a forgot-password attempt. Brute-force is still mitigated by
// the per-account failed_login_count lockout in the auth controller.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
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
