const { query } = require('../../config/database');
const geolib = require('geolib');
const dayjs = require('dayjs');

const COMPANY_LAT = parseFloat(process.env.COMPANY_LAT || '13.7563');
const COMPANY_LNG = parseFloat(process.env.COMPANY_LNG || '100.5018');
const MAX_RADIUS = parseInt(process.env.CHECKIN_RADIUS_METERS || '60');

// Resolve the active shift_configs row for an employee on a given date.
// Priority:
//   1. employees.weekly_shifts[dayOfWeek] — if it's "dayoff", short-circuit;
//      otherwise look up the shift_configs row by code.
//   2. Fall back to the first active shift_configs row whose shift_type
//      matches employees.shift_type ('normal' / 'flexible').
//   3. Return { config: null } if no config exists — caller should use
//      built-in defaults so the system still works on a fresh install.
async function resolveShiftConfig(empId, date) {
  const emp = await query(
    `SELECT id, shift_type, weekly_shifts FROM employees WHERE id = $1`,
    [empId]
  );
  if (!emp.rows[0]) return { config: null, isDayOff: false };
  const e = emp.rows[0];
  const dow = String(dayjs(date).day());
  const weeklyCode = e.weekly_shifts && e.weekly_shifts[dow];

  if (weeklyCode === 'dayoff') {
    return { config: null, isDayOff: true };
  }
  if (weeklyCode) {
    const r = await query(
      `SELECT * FROM shift_configs WHERE code = $1 AND is_active = true LIMIT 1`,
      [weeklyCode]
    );
    if (r.rows[0]) return { config: r.rows[0], isDayOff: false };
  }
  const fallback = await query(
    `SELECT * FROM shift_configs
       WHERE shift_type = $1 AND is_active = true
       ORDER BY created_at ASC LIMIT 1`,
    [e.shift_type || 'normal']
  );
  return { config: fallback.rows[0] || null, isDayOff: false };
}

// "HH:MM[:SS]" → minutes since midnight. Tolerant of seconds suffix and
// PG TIME values which serialize either way.
function timeToMin(t) {
  if (!t) return 0;
  const parts = String(t).split(':');
  return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

// Status calculation that honors the shift_configs thresholds.
// Returns { status, detail, almostLate } where almostLate flags the
// in-between bucket so the summaries can count it separately later
// without breaking the existing status enum (still one of present/
// late/absent — Phase 3 will surface almostLate as its own bucket).
function calcStatus(now, cfg) {
  const totalMin = now.hour() * 60 + now.minute();

  // No config configured anywhere — fall back to the original hardcoded
  // 9:00 schedule so a brand-new install with no shift_configs row
  // still produces useful statuses.
  if (!cfg) {
    if (totalMin <= 9 * 60)        return { status: 'present', detail: 'เข้างานตรงเวลา', almostLate: false };
    if (totalMin <= 9 * 60 + 9)    return { status: 'present', detail: 'เกือบสาย',       almostLate: true  };
    if (totalMin <= 9 * 60 + 19)   return { status: 'late',    detail: 'สาย',            almostLate: false };
    return { status: 'absent', detail: 'ขาดงาน', almostLate: false };
  }

  // Flexible shift: the staggered tiers describe (latest-check-in, expected-checkout).
  // Earliest tier the employee still qualifies for wins. If no tier
  // matches, fall through to a single late grace period using
  // late_threshold_minutes past the last tier's check-in cutoff.
  if (cfg.shift_type === 'flexible' && Array.isArray(cfg.flex_tiers) && cfg.flex_tiers.length > 0) {
    const sorted = [...cfg.flex_tiers].sort((a, b) => timeToMin(a.checkin_until) - timeToMin(b.checkin_until));
    for (const tier of sorted) {
      if (totalMin <= timeToMin(tier.checkin_until)) {
        return { status: 'present', detail: `ออกงาน ${tier.checkout || '?'}`, almostLate: false };
      }
    }
    const lastTier = sorted[sorted.length - 1];
    const lastEnd = timeToMin(lastTier.checkin_until);
    const lateMax = lastEnd + (cfg.late_threshold_minutes || 10);
    if (totalMin <= lateMax) {
      return { status: 'late', detail: `สาย (ออกงาน ${lastTier.checkout || '?'})`, almostLate: false };
    }
    return { status: 'absent', detail: 'ขาดงาน (เลยเวลาเช็คอินสุดท้าย)', almostLate: false };
  }

  // Normal shift: buckets cascade from work_start using the configured
  // late_warning / late_threshold / absent_threshold offsets. Anything
  // before (work_start + late_warning_minutes) is "ตรงเวลา" — that gap
  // is the implicit grace window.
  const workStart   = timeToMin(cfg.work_start || '09:00');
  const lateWarn    = cfg.late_warning_minutes    ?? 1;
  const lateTh      = cfg.late_threshold_minutes  ?? 10;
  const absentTh    = cfg.absent_threshold_minutes ?? 20;

  if (totalMin < workStart + lateWarn) return { status: 'present', detail: 'เข้างานตรงเวลา', almostLate: false };
  if (totalMin < workStart + lateTh)   return { status: 'present', detail: 'เกือบสาย',       almostLate: true  };
  if (totalMin < workStart + absentTh) return { status: 'late',    detail: 'สาย',            almostLate: false };
  return { status: 'absent', detail: 'ขาดงาน', almostLate: false };
}

// POST /api/attendance/check-in
const checkIn = async (req, res) => {
  try {
    const { lat, lng, method = 'gps', selfie } = req.body;
    const today = dayjs().format('YYYY-MM-DD');
    const now = dayjs();

    // Selfie size guard. ~500KB cap is enough for a 480px JPEG at ~0.7
    // quality and keeps the Postgres row well under TOAST thresholds.
    if (selfie && typeof selfie === 'string' && selfie.length > 700 * 1024) {
      return res.status(413).json({ success: false, message: 'รูปเซลฟี่ใหญ่เกินไป (สูงสุด ~500KB)' });
    }

    // ดึงข้อมูล employee
    const empResult = await query(
      'SELECT e.id, e.shift_type FROM employees e WHERE e.user_id = $1 AND e.is_active = true',
      [req.user.id]
    );
    if (!empResult.rows[0]) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    }
    const emp = empResult.rows[0];

    // ตรวจสอบว่าเช็คอินวันนี้แล้วหรือยัง
    const existing = await query(
      'SELECT id, check_in_at FROM attendance_logs WHERE employee_id = $1 AND date = $2',
      [emp.id, today]
    );
    if (existing.rows[0]?.check_in_at) {
      return res.status(409).json({ success: false, message: 'เช็คอินวันนี้แล้ว' });
    }

    // ตรวจสอบ GPS
    let distanceM = null;
    if (method === 'gps') {
      if (!lat || !lng) {
        return res.status(400).json({ success: false, message: 'กรุณาเปิด GPS' });
      }
      distanceM = geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: COMPANY_LAT, longitude: COMPANY_LNG }
      );
      if (distanceM > MAX_RADIUS) {
        return res.status(400).json({
          success: false,
          message: `อยู่นอกรัศมี ${MAX_RADIUS} เมตร (ระยะปัจจุบัน ${distanceM} ม.)`,
          data: { distance: distanceM, maxRadius: MAX_RADIUS }
        });
      }
    }

    // Resolve the active shift config for today and compute status from it.
    // This honors the weekly schedule + the rules HR set in /shifts (work_start,
    // late thresholds, flex tiers), instead of the previous hardcoded 9:00.
    const { config: shiftCfg, isDayOff } = await resolveShiftConfig(emp.id, today);
    if (isDayOff) {
      return res.status(400).json({ success: false, message: 'วันนี้เป็นวันหยุดของคุณ ไม่ต้องลงเวลา' });
    }
    const { status, detail, almostLate } = calcStatus(now, shiftCfg);

    // บันทึก
    const result = await query(
      `INSERT INTO attendance_logs
        (employee_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance_m, check_in_method, status, status_detail, check_in_selfie, almost_late)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (employee_id, date) DO UPDATE SET
        check_in_at = NOW(), check_in_lat = $3, check_in_lng = $4,
        check_in_distance_m = $5, check_in_method = $6, status = $7, status_detail = $8,
        check_in_selfie = COALESCE($9, attendance_logs.check_in_selfie),
        almost_late = $10,
        updated_at = NOW()
       RETURNING *`,
      [emp.id, today, lat, lng, distanceM, method, status, detail, selfie || null, !!almostLate]
    );

    res.json({
      success: true,
      message: `เช็คอินสำเร็จ — ${detail}`,
      data: {
        checkInAt: result.rows[0].check_in_at,
        status,
        statusDetail: detail,
        distance: distanceM
      }
    });
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/attendance/check-out
const checkOut = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const today = dayjs().format('YYYY-MM-DD');

    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;

    const log = await query(
      'SELECT * FROM attendance_logs WHERE employee_id = $1 AND date = $2',
      [empId, today]
    );
    if (!log.rows[0]) return res.status(400).json({ success: false, message: 'ยังไม่ได้เช็คอินวันนี้' });
    if (log.rows[0].check_out_at) return res.status(409).json({ success: false, message: 'เช็คเอาท์วันนี้แล้ว' });

    const checkInAt = dayjs(log.rows[0].check_in_at);
    const checkOutAt = dayjs();
    const workHours = parseFloat((checkOutAt.diff(checkInAt, 'minute') / 60).toFixed(2));
    const otHours = workHours > 8 ? parseFloat((workHours - 8).toFixed(2)) : 0;

    await query(
      `UPDATE attendance_logs SET
        check_out_at = NOW(), check_out_lat = $1, check_out_lng = $2,
        work_hours = $3, ot_hours = $4, updated_at = NOW()
       WHERE employee_id = $5 AND date = $6`,
      [lat, lng, workHours, otHours, empId, today]
    );

    res.json({
      success: true,
      message: 'เช็คเอาท์สำเร็จ',
      data: { checkOutAt: checkOutAt.toISOString(), workHours, otHours }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/today
// Also returns the active shift info so the UI can render the expected
// work_start time + countdown ("เหลือ N นาทีก่อนสาย") without a
// second round-trip to /shift-configs.
const getToday = async (req, res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;

    const [logRes, shift] = await Promise.all([
      query('SELECT * FROM attendance_logs WHERE employee_id = $1 AND date = $2', [empId, today]),
      resolveShiftConfig(empId, today),
    ]);

    const log = logRes.rows[0] || null;
    const shiftPayload = shift.isDayOff
      ? { isDayOff: true }
      : shift.config
        ? {
            isDayOff: false,
            id: shift.config.id,
            code: shift.config.code,
            name: shift.config.name,
            shift_type: shift.config.shift_type,
            work_start: shift.config.work_start,
            work_end: shift.config.work_end,
            checkin_start: shift.config.checkin_start,
            checkin_end: shift.config.checkin_end,
            late_warning_minutes: shift.config.late_warning_minutes,
            late_threshold_minutes: shift.config.late_threshold_minutes,
            absent_threshold_minutes: shift.config.absent_threshold_minutes,
            flex_tiers: shift.config.flex_tiers,
          }
        : null;

    res.json({ success: true, data: log, shift: shiftPayload });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/daily-summary?date=YYYY-MM-DD (HR/Owner only)
const getDailySummary = async (req, res) => {
  try {
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    const [total, logs] = await Promise.all([
      query('SELECT COUNT(*) as count FROM employees WHERE is_active = true'),
      query(
        `SELECT a.*, e.first_name, e.last_name, e.employee_id as emp_code,
                d.name as department, e.shift_type
         FROM attendance_logs a
         JOIN employees e ON a.employee_id = e.id
         LEFT JOIN departments d ON e.department_id = d.id
         WHERE a.date = $1
         ORDER BY a.check_in_at ASC NULLS LAST`,
        [date]
      )
    ]);

    const totalEmp = parseInt(total.rows[0].count);
    // Note: present is the total green-bucket count (includes almost_late
    // rows). almostLate is broken out as its own number so the UI can show
    // it as a separate 5th bucket without double-counting.
    const present    = logs.rows.filter(r => r.status === 'present').length;
    const almostLate = logs.rows.filter(r => r.status === 'present' && r.almost_late).length;
    const late       = logs.rows.filter(r => r.status === 'late').length;
    const absent     = logs.rows.filter(r => r.status === 'absent').length;
    const onLeave    = logs.rows.filter(r => r.status === 'leave').length;

    res.json({
      success: true,
      data: {
        date,
        summary: {
          total: totalEmp,
          present,
          almostLate,
          late,
          absent,
          leave: onLeave,
          notCheckedIn: totalEmp - logs.rows.length,
          attendanceRate: parseFloat(((present + late) / totalEmp * 100).toFixed(1))
        },
        records: logs.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/recent-summary?days=5
// Returns one row per day for the last N working days (Mon–Fri).
// Used by the dashboard's "การมาทำงาน X วัน" chart so it stops showing
// hardcoded mock numbers. HR/owner only.
const getRecentSummary = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 5, 1), 31);
    const end = dayjs();

    // Collect last N working days going backwards from today.
    const dates = [];
    let cur = end;
    while (dates.length < days) {
      if (cur.day() !== 0 && cur.day() !== 6) dates.push(cur.format('YYYY-MM-DD'));
      cur = cur.subtract(1, 'day');
    }
    dates.reverse();

    const start = dates[0];
    const stop  = dates[dates.length - 1];

    const result = await query(
      `SELECT date::text AS d,
              COUNT(*) FILTER (WHERE status = 'present' AND NOT almost_late)::int AS present,
              COUNT(*) FILTER (WHERE status = 'present' AND almost_late)::int     AS almost_late,
              COUNT(*) FILTER (WHERE status = 'late')::int                        AS late,
              COUNT(*) FILTER (WHERE status = 'absent')::int                      AS absent,
              COUNT(*) FILTER (WHERE status = 'leave')::int                       AS leave,
              COUNT(*) FILTER (WHERE status = 'very_late')::int                   AS very_late
       FROM attendance_logs
       WHERE date BETWEEN $1 AND $2
       GROUP BY date`,
      [start, stop]
    );
    const byDate = {};
    for (const r of result.rows) byDate[r.d] = r;

    // Thai single-char day labels (Sun..Sat) to match the dashboard's
    // existing axis style: อา / จ / อ / พ / พฤ / ศ / ส.
    const DAY_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
    const rows = dates.map(d => {
      const dow = dayjs(d).day();
      const row = byDate[d] || { present: 0, almost_late: 0, late: 0, absent: 0, leave: 0, very_late: 0 };
      return {
        date: d,
        day: DAY_TH[dow],
        present: row.present,                       // ตรงเวลาเป๊ะ (not almost_late)
        almost_late: row.almost_late,               // เกือบสาย — own bar so dashboard can show it
        late: row.late + row.very_late,             // collapse very_late into late
        absent: row.absent,
        leave: row.leave,
      };
    });

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /attendance/recent-summary error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/my-history?month=5&year=2025
const getMyHistory = async (req, res) => {
  try {
    const { month, year } = req.query;
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });

    const result = await query(
      `SELECT * FROM attendance_logs
       WHERE employee_id = $1
         AND EXTRACT(MONTH FROM date) = $2
         AND EXTRACT(YEAR FROM date) = $3
       ORDER BY date DESC`,
      [empResult.rows[0].id, month || dayjs().month() + 1, year || dayjs().year()]
    );

    const summary = {
      present:    result.rows.filter(r => r.status === 'present').length,
      almostLate: result.rows.filter(r => r.status === 'present' && r.almost_late).length,
      late:       result.rows.filter(r => r.status === 'late').length,
      absent:     result.rows.filter(r => r.status === 'absent').length,
      totalWorkHours: result.rows.reduce((s, r) => s + (parseFloat(r.work_hours) || 0), 0).toFixed(1),
      totalOtHours:   result.rows.reduce((s, r) => s + (parseFloat(r.ot_hours)   || 0), 0).toFixed(1),
    };

    res.json({ success: true, data: { summary, records: result.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = { checkIn, checkOut, getToday, getDailySummary, getMyHistory, getRecentSummary };
