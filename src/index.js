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
    // Link employees to a row in the positions tree. The legacy `position`
    // VARCHAR column stays in place — we write both in sync so existing
    // SELECT e.position queries keep working — but position_id is the
    // canonical reference for joins, structure navigation, and the future
    // position-aware org chart.
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS position_id UUID REFERENCES positions(id) ON DELETE SET NULL
    `);
    // One-shot backfill: any employee with a position string that exactly
    // matches a positions.name gets linked. Idempotent (only fills NULLs)
    // so safe to run on every boot. Names not found stay text-only.
    await client.query(`
      UPDATE employees e
         SET position_id = p.id
        FROM positions p
       WHERE e.position_id IS NULL
         AND e.position IS NOT NULL
         AND e.position = p.name
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
    // Audit log table — defensively created here because the middleware's
    // INSERT silently swallows errors (so it never breaks the actual API
    // response), which meant a missing table on legacy DBs caused every
    // single audit event to vanish without a trace. With this in place
    // the /audit-logs viewer actually has data to display.
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        resource VARCHAR(100),
        resource_id VARCHAR(100),
        details JSONB,
        ip_address INET,
        device_info VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Legacy prod DBs had an older audit_logs schema with fewer columns —
    // CREATE TABLE IF NOT EXISTS above doesn't help when the table is
    // already there. Render logs were screaming
    //   "column 'resource_id' of relation 'audit_logs' does not exist"
    // on every INSERT. Defensively ADD each post-creation column so the
    // middleware's INSERT (which writes resource_id, details, ip_address,
    // device_info) succeeds even on a partially-migrated table.
    const auditColumns = [
      ['resource',    'VARCHAR(100)'],
      ['resource_id', 'VARCHAR(100)'],
      ['details',     'JSONB'],
      ['ip_address',  'INET'],
      ['device_info', 'VARCHAR(500)'],
    ];
    for (const [name, type] of auditColumns) {
      await client.query(
        `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)
    `);
    // In-app notifications. One row per delivery (no fan-out by group);
    // server-side helpers in middleware/notify.js fan out a single event
    // to multiple recipients (e.g. notify all HR+owner when an employee
    // files leave). type is an enum-like discriminator the frontend uses
    // for icon/color; title/body are pre-rendered Thai strings; link is
    // the in-app route to navigate to when the user clicks the row.
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        VARCHAR(50) NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        link        VARCHAR(200),
        related_id  UUID,
        read_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Partial index on the unread set — unread-count queries hit a tiny
    // slice of the table even after notifications accumulate to millions.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
        ON notifications(user_id) WHERE read_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
        ON notifications(user_id, created_at DESC)
    `);
    // Selfie at check-in: base64 JPEG dataURL captured client-side. TEXT
    // because dataURLs run ~30-100KB after resize + JPEG compression, far
    // past any VARCHAR limit. Used by HR to verify the person who tapped
    // "เช็คอิน" is actually them, not a buddy clocking in from elsewhere.
    await client.query(`
      ALTER TABLE attendance_logs
      ADD COLUMN IF NOT EXISTS check_in_selfie TEXT
    `);
    // "เกือบสาย" tracked as a first-class flag rather than only being
    // visible via status_detail string matching. Keeps the status enum
    // unchanged (present/late/absent/leave) — almost_late=true just
    // refines a 'present' row into the warning bucket. Counts on
    // /daily-summary, /recent-summary, and /my-history use this column
    // so the summaries can surface a 5th bucket without parsing text.
    await client.query(`
      ALTER TABLE attendance_logs
      ADD COLUMN IF NOT EXISTS almost_late BOOLEAN DEFAULT false
    `);
    // One-time backfill from the existing status_detail text. Idempotent
    // because it only writes rows where almost_late is still the default
    // false and the detail matches the legacy phrase.
    await client.query(`
      UPDATE attendance_logs
         SET almost_late = true
       WHERE almost_late = false
         AND status = 'present'
         AND status_detail = 'เกือบสาย'
    `);
    // Backdated check-in/check-out requests: an employee submits a fix
    // for a past day they forgot to log (forgot to tap เช็คอิน, or left
    // without เช็คเอาท์). Each row is one request; HR/owner approves
    // (which then writes/updates the actual attendance_logs row for
    // that date) or rejects with a reason. Kept in its own table so
    // the historical request audit survives even after the attendance
    // row gets recomputed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance_backdate_requests (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id     UUID REFERENCES employees(id) ON DELETE CASCADE,
        date            DATE NOT NULL,
        request_type    VARCHAR(20) NOT NULL CHECK (request_type IN ('check_in','check_out','both')),
        check_in_time   TIME,
        check_out_time  TIME,
        reason          TEXT NOT NULL,
        status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected')),
        reviewed_by     UUID REFERENCES users(id),
        reviewed_at     TIMESTAMPTZ,
        reject_reason   TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backdate_status ON attendance_backdate_requests(status, date DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backdate_employee ON attendance_backdate_requests(employee_id, created_at DESC)
    `);
    // Off-site check-in: lets a field/remote employee log a check-in
    // outside the company GPS radius with a reason; HR/owner approves
    // before it counts as a real attendance entry. is_offsite=true rows
    // start with offsite_status='pending'; the status (present/late/etc)
    // is still computed normally from the shift schedule so HR sees the
    // would-be bucket when reviewing. Pending rows are still in
    // attendance_logs but payroll/final stats should treat them as
    // not-yet-counted by filtering offsite_status='pending'.
    const offsiteColumns = [
      ['is_offsite',           'BOOLEAN DEFAULT false'],
      ['offsite_reason',       'TEXT'],
      ['offsite_status',       "VARCHAR(20)"],   // 'pending' | 'approved' | 'rejected'
      ['offsite_approved_by',  'UUID REFERENCES users(id)'],
      ['offsite_approved_at',  'TIMESTAMPTZ'],
      ['offsite_reject_reason','TEXT'],
    ];
    for (const [name, type] of offsiteColumns) {
      await client.query(
        `ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );
    }
    // Payroll. Legacy DBs created before migrate.js added payroll_records
    // won't have this table, so create it defensively on every boot.
    // net_salary is a GENERATED column — Postgres recomputes it on every
    // UPDATE so the UI never has to worry about keeping it in sync.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        month INT NOT NULL,
        year INT NOT NULL,
        base_salary NUMERIC(12,2) NOT NULL,
        ot_amount NUMERIC(12,2) DEFAULT 0,
        bonus NUMERIC(12,2) DEFAULT 0,
        allowances NUMERIC(12,2) DEFAULT 0,
        social_security NUMERIC(12,2) DEFAULT 0,
        income_tax NUMERIC(12,2) DEFAULT 0,
        other_deductions NUMERIC(12,2) DEFAULT 0,
        net_salary NUMERIC(12,2) GENERATED ALWAYS AS
          (base_salary + ot_amount + bonus + allowances - social_security - income_tax - other_deductions) STORED,
        work_days INT,
        absent_days INT DEFAULT 0,
        late_count INT DEFAULT 0,
        ot_hours NUMERIC(5,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
        paid_at TIMESTAMPTZ,
        slip_sent_at TIMESTAMPTZ,
        notes TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, month, year)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll_records(employee_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_records(year, month)
    `);
    // Singleton org-wide settings (company name, address, etc.).
    // Enforced single-row via PK = 1; everything else is a nullable column.
    // Read by anyone authenticated; write by owner only (enforced in routes).
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        company_name TEXT,
        company_name_en TEXT,
        company_address TEXT,
        company_phone VARCHAR(50),
        company_email VARCHAR(200),
        company_tax_id VARCHAR(50),
        company_logo TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Seed the singleton row if missing — ON CONFLICT keeps it idempotent.
    await client.query(`
      INSERT INTO org_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
    `);
    // KPI tables — defensive in case prod DB predates migrate.js.
    // criteria: weighted rubric items. weight is a relative number (no need
    // to sum to 100); the review-overall formula divides by the sum of the
    // weights actually used so it stays correct regardless.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kpi_criteria (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        weight NUMERIC(5,2) DEFAULT 100,
        department_id UUID REFERENCES departments(id),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // reviews: one per (employee, quarter, year). scores is a JSONB array of
    // { criterionId, score (1-5), note? }. overall_score is 0-100, computed
    // server-side as weighted_avg(score) × 20.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kpi_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        reviewer_id UUID REFERENCES users(id),
        quarter INT NOT NULL CHECK (quarter IN (1,2,3,4)),
        year INT NOT NULL,
        scores JSONB NOT NULL DEFAULT '[]',
        overall_score NUMERIC(5,2),
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
        comments TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, quarter, year)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kpi_reviews_employee ON kpi_reviews(employee_id, year DESC, quarter DESC)
    `);
    // ====== CLEANING ROSTER ======
    // Shared-responsibility cleaning rota. Master list of items + a tiny
    // schedule config + a round-robin inspector queue. Each scheduled day
    // gets exactly one session row with a snapshot of the active items
    // (so editing the master list doesn't rewrite history).
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        display_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Singleton row at id=1 — weekdays as INT[] (0=Sun..6=Sat).
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        weekdays INT[] DEFAULT '{}',
        start_time TIME DEFAULT '09:00',
        end_time TIME DEFAULT '09:30',
        is_active BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO cleaning_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    // Inspector queue. position is the round-robin ordinal; pointer below
    // advances modulo COUNT(is_active=true) so removing/reordering people
    // still works without rewriting all positions.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_inspector_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE UNIQUE,
        position INT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_queue_pointer (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        next_position INT DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO cleaning_queue_pointer (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    // One session per calendar day. status flow:
    //   open → inspector_reviewed → approved
    //                            └→ rejected (back to open for rework)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_date DATE NOT NULL UNIQUE,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        inspector_id UUID REFERENCES employees(id),
        status VARCHAR(30) DEFAULT 'open' CHECK (status IN ('open','inspector_reviewed','approved','rejected')),
        inspector_notes TEXT,
        inspector_completed_at TIMESTAMPTZ,
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        hr_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cleaning_sessions_date ON cleaning_sessions(session_date DESC)
    `);
    // Snapshot of the master list at session-create time. item_name is the
    // text shown forever; item_id is a soft reference (SET NULL if master
    // row deleted) only kept for analytics.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cleaning_session_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES cleaning_sessions(id) ON DELETE CASCADE,
        item_id UUID REFERENCES cleaning_items(id) ON DELETE SET NULL,
        item_name VARCHAR(200) NOT NULL,
        display_order INT DEFAULT 0,
        done_by_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
        inspector_note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cleaning_session_items_session ON cleaning_session_items(session_id)
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
