/**
 * Migration v2 — add manager_id to employees for individual reporting hierarchy.
 *
 * Idempotent: safe to run multiple times. Run with: npm run migrate:v2
 */
const { pool } = require('../../config/database');
require('dotenv').config({ path: '../../.env' });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('🔨 Running migration v2...');

    // 1) Add manager_id column for individual hierarchy (separate from
    //    departments.manager_id which is the department lead).
    await client.query(`
      ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id) ON DELETE SET NULL
    `);
    console.log('  ✓ employees.manager_id');

    // 2) Index for manager lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id)
    `);
    console.log('  ✓ idx_employees_manager');

    await client.query('COMMIT');
    console.log('✅ Migration v2 complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration v2 failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
