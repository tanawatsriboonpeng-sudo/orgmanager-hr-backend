const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '../../.env' });

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('🌱 Seeding initial data...');

    // Departments
    const depts = await client.query(`
      INSERT INTO departments (name, description) VALUES
        ('IT', 'ฝ่ายเทคโนโลยีสารสนเทศ'),
        ('HR', 'ฝ่ายทรัพยากรบุคคล'),
        ('Finance', 'ฝ่ายการเงินและบัญชี'),
        ('Operations', 'ฝ่ายปฏิบัติการ'),
        ('Marketing', 'ฝ่ายการตลาด')
      ON CONFLICT DO NOTHING
      RETURNING id, name
    `);
    console.log(`  ✓ ${depts.rowCount} departments`);

    // Users (hash password '1234' for demo)
    const hash = await bcrypt.hash('1234', 12);
    const users = await client.query(`
      INSERT INTO users (employee_id, email, password_hash, role) VALUES
        ('EMP-000', 'owner@company.co.th', $1, 'owner'),
        ('EMP-HR1', 'hr@company.co.th', $1, 'hr'),
        ('EMP-001', 'somchai@company.co.th', $1, 'employee'),
        ('EMP-002', 'napa@company.co.th', $1, 'employee'),
        ('EMP-003', 'vichai@company.co.th', $1, 'employee'),
        ('EMP-004', 'malee@company.co.th', $1, 'employee'),
        ('EMP-005', 'piti@company.co.th', $1, 'employee')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, role, employee_id
    `, [hash]);
    console.log(`  ✓ ${users.rowCount} users (password: 1234)`);

    const userMap = {};
    users.rows.forEach(u => { userMap[u.email] = u.id; });

    const itDept = depts.rows.find(d => d.name === 'IT')?.id;
    const hrDept = depts.rows.find(d => d.name === 'HR')?.id;
    const finDept = depts.rows.find(d => d.name === 'Finance')?.id;
    const opsDept = depts.rows.find(d => d.name === 'Operations')?.id;

    // Employees
    const emps = await client.query(`
      INSERT INTO employees (user_id, employee_id, first_name, last_name, department_id, position, shift_type, base_salary, start_date) VALUES
        ($1, 'EMP-000', 'ประพันธ์', 'เจ้าของ', $6, 'CEO / เจ้าของ', 'normal', 0, '2020-01-01'),
        ($2, 'EMP-HR1', 'มาลี', 'รักงาน', $7, 'HR Manager', 'normal', 52000, '2021-03-01'),
        ($3, 'EMP-001', 'สมชาย', 'ใจดี', $6, 'Developer', 'normal', 35000, '2023-03-01'),
        ($4, 'EMP-002', 'นภา', 'สวัสดี', $8, 'บัญชี', 'flexible', 28000, '2022-06-15'),
        ($5, 'EMP-003', 'วิชัย', 'แข็งแรง', $9, 'หัวหน้าทีม', 'normal', 45000, '2021-01-10'),
        (NULL, 'EMP-004', 'ปิติ', 'มุมานะ', $6, 'Designer', 'flexible', 22000, '2023-11-05')
      ON CONFLICT (employee_id) DO NOTHING
      RETURNING id, employee_id
    `, [
      userMap['owner@company.co.th'],
      userMap['hr@company.co.th'],
      userMap['somchai@company.co.th'],
      userMap['napa@company.co.th'],
      userMap['vichai@company.co.th'],
      itDept, hrDept, finDept, opsDept
    ]);
    console.log(`  ✓ ${emps.rowCount} employees`);

    // Leave types
    const leaveTypes = await client.query(`
      INSERT INTO leave_types (name, code, days_per_year, carry_over_days, advance_notice_days, requires_document) VALUES
        ('ลากิจ', 'BUSINESS', 3, 0, 3, false),
        ('ลาพักร้อน', 'ANNUAL', 6, 6, 7, false),
        ('ลาป่วย', 'SICK', 30, 0, 0, true),
        ('วันหยุดพิเศษ', 'SPECIAL', 0, 0, 1, false)
      ON CONFLICT (code) DO NOTHING
      RETURNING id, code
    `);
    console.log(`  ✓ ${leaveTypes.rowCount} leave types`);

    // Holidays 2568
    await client.query(`
      INSERT INTO holidays (name, date, type, year) VALUES
        ('วันแรงงานแห่งชาติ', '2025-05-01', 'national', 2025),
        ('วันฉัตรมงคล', '2025-05-05', 'national', 2025),
        ('วันวิสาขบูชา', '2025-05-12', 'national', 2025),
        ('วันเฉลิมพระชนมพรรษา ร.10', '2025-07-28', 'national', 2025),
        ('วันแม่แห่งชาติ', '2025-08-12', 'national', 2025),
        ('วันปิยมหาราช', '2025-10-23', 'national', 2025),
        ('วันพ่อแห่งชาติ', '2025-12-05', 'national', 2025),
        ('วันรัฐธรรมนูญ', '2025-12-10', 'national', 2025),
        ('วันสิ้นปี', '2025-12-31', 'national', 2025)
      ON CONFLICT (date) DO NOTHING
    `);
    console.log('  ✓ Holidays 2568');

    // Shift configs
    await client.query(`
      INSERT INTO shift_configs (name, shift_type, work_days, checkin_start, checkin_end, work_start, work_end, grace_minutes, late_threshold_minutes, absent_threshold_minutes) VALUES
        ('กะปกติ (จ-อ-พฤ)', 'normal', ARRAY[1,2,3,4,5,6], '08:30', '09:00', '09:00', '17:00', 0, 10, 20),
        ('Flexible (พ-ศ-ส)', 'flexible', ARRAY[3,5,6], '07:00', '10:05', '09:00', '17:00', 0, 75, 80)
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ Shift configs');

    // Sample announcement
    await client.query(`
      INSERT INTO announcements (title, content, type, created_by) VALUES
        ('ยินดีต้อนรับสู่ OrgManager HR', 'ระบบ HR ใหม่เริ่มใช้งานแล้ววันนี้ กรุณาตั้งรหัสผ่านใหม่ในการเข้าสู่ระบบครั้งแรก', 'info', $1)
      ON CONFLICT DO NOTHING
    `, [userMap['hr@company.co.th']]);
    console.log('  ✓ Sample announcement');

    await client.query('COMMIT');
    console.log('\n✅ Seed completed!');
    console.log('\n📋 Test accounts:');
    console.log('  owner@company.co.th  / 1234  → เจ้าของ');
    console.log('  hr@company.co.th     / 1234  → HR Admin');
    console.log('  somchai@company.co.th/ 1234  → พนักงาน');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
