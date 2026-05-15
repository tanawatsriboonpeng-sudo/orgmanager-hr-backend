const { pool } = require('../config/database');
require('dotenv').config({ path: '../../.env' });

const createTables = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('🔨 Creating tables...');

    // ====== USERS & AUTH ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('owner','hr','employee')),
        is_active BOOLEAN DEFAULT true,
        last_login_at TIMESTAMPTZ,
        failed_login_count INT DEFAULT 0,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        device_info VARCHAR(500),
        ip_address INET,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

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

    // ====== EMPLOYEES ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        manager_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        employee_id VARCHAR(20) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        nickname VARCHAR(50),
        phone VARCHAR(20),
        department_id UUID REFERENCES departments(id),
        position VARCHAR(100),
        shift_type VARCHAR(20) DEFAULT 'normal' CHECK (shift_type IN ('normal','flexible')),
        employment_type VARCHAR(20) DEFAULT 'fulltime' CHECK (employment_type IN ('fulltime','parttime','contract','probation')),
        start_date DATE NOT NULL,
        contract_end_date DATE,
        base_salary NUMERIC(12,2) DEFAULT 0,
        bank_account VARCHAR(50),
        bank_name VARCHAR(100),
        national_id VARCHAR(20),
        avatar_url VARCHAR(500),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ====== ATTENDANCE ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) NOT NULL,
        shift_type VARCHAR(20) NOT NULL,
        work_days INTEGER[] NOT NULL,
        checkin_start TIME NOT NULL,
        checkin_end TIME NOT NULL,
        work_start TIME NOT NULL,
        work_end TIME NOT NULL,
        grace_minutes INT DEFAULT 0,
        late_threshold_minutes INT DEFAULT 10,
        absent_threshold_minutes INT DEFAULT 20,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        check_in_at TIMESTAMPTZ,
        check_out_at TIMESTAMPTZ,
        check_in_lat NUMERIC(10,7),
        check_in_lng NUMERIC(10,7),
        check_out_lat NUMERIC(10,7),
        check_out_lng NUMERIC(10,7),
        check_in_distance_m INT,
        check_in_method VARCHAR(20) DEFAULT 'gps' CHECK (check_in_method IN ('gps','manual','biometric')),
        status VARCHAR(20) CHECK (status IN ('present','late','very_late','absent','leave','holiday')),
        status_detail VARCHAR(100),
        work_hours NUMERIC(4,2),
        ot_hours NUMERIC(4,2) DEFAULT 0,
        notes TEXT,
        approved_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, date)
      )
    `);

    // ====== LEAVE ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        code VARCHAR(20) UNIQUE NOT NULL,
        days_per_year INT NOT NULL,
        carry_over_days INT DEFAULT 0,
        advance_notice_days INT DEFAULT 1,
        requires_document BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_quotas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        leave_type_id UUID REFERENCES leave_types(id),
        year INT NOT NULL,
        total_days INT NOT NULL,
        used_days INT DEFAULT 0,
        remaining_days INT GENERATED ALWAYS AS (total_days - used_days) STORED,
        UNIQUE(employee_id, leave_type_id, year)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        leave_type_id UUID REFERENCES leave_types(id),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days_count INT NOT NULL,
        reason TEXT NOT NULL,
        document_url VARCHAR(500),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        hr_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ====== HOLIDAYS ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        date DATE NOT NULL,
        type VARCHAR(20) DEFAULT 'national' CHECK (type IN ('national','company','compensatory')),
        year INT NOT NULL,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(date)
      )
    `);

    // ====== OVERTIME ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS ot_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        hours NUMERIC(4,2) NOT NULL,
        reason TEXT NOT NULL,
        rate NUMERIC(3,1) DEFAULT 1.5,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','manager_approved','hr_approved','rejected')),
        manager_approved_by UUID REFERENCES users(id),
        manager_approved_at TIMESTAMPTZ,
        hr_approved_by UUID REFERENCES users(id),
        hr_approved_at TIMESTAMPTZ,
        rejected_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ====== PAYROLL ======
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

    // ====== KPI ======
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

    // ====== PROJECTS ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('planning','active','on_hold','completed','cancelled')),
        priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('urgent','high','medium','low')),
        owner_id UUID REFERENCES users(id),
        start_date DATE,
        due_date DATE,
        progress INT DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        space VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        assignee_id UUID REFERENCES employees(id),
        status VARCHAR(30) DEFAULT 'todo' CHECK (status IN ('todo','inprogress','review','done','cancelled')),
        priority VARCHAR(20) DEFAULT 'medium',
        due_date DATE,
        start_date DATE,
        progress INT DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        estimated_hours NUMERIC(5,2),
        actual_hours NUMERIC(5,2) DEFAULT 0,
        tags TEXT[],
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ====== ANNOUNCEMENTS ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(300) NOT NULL,
        content TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'info' CHECK (type IN ('info','important','holiday','urgent')),
        target_roles TEXT[] DEFAULT ARRAY['owner','hr','employee'],
        target_departments UUID[],
        created_by UUID REFERENCES users(id),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS announcement_reads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        announcement_id UUID REFERENCES announcements(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id),
        read_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(announcement_id, user_id)
      )
    `);

    // ====== DAILY SUMMARY ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        date DATE UNIQUE NOT NULL,
        total_employees INT,
        present_count INT,
        late_count INT,
        absent_count INT,
        leave_count INT,
        ot_hours NUMERIC(6,2),
        attendance_rate NUMERIC(5,2),
        summary_data JSONB,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ====== INDEXES ======
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_logs(employee_id, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_logs(date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ot_requests_employee ON ot_requests(employee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)`);

    await client.query('COMMIT');
    console.log('✅ All tables created successfully!');
    console.log('👉 Run: npm run seed to add initial data');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

createTables();
