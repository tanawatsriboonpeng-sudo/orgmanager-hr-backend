const { query } = require('../../config/database');
const geolib = require('geolib');
const dayjs = require('dayjs');

const COMPANY_LAT = parseFloat(process.env.COMPANY_LAT || '13.7563');
const COMPANY_LNG = parseFloat(process.env.COMPANY_LNG || '100.5018');
const MAX_RADIUS = parseInt(process.env.CHECKIN_RADIUS_METERS || '60');

// คำนวณสถานะ check-in
const calcStatus = (checkInTime, shiftType) => {
  const h = checkInTime.hour();
  const m = checkInTime.minute();
  const totalMin = h * 60 + m;

  if (shiftType === 'flexible') {
    if (totalMin <= 7 * 60 + 5) return { status: 'present', detail: 'ออกงาน 15:00' };
    if (totalMin <= 8 * 60 + 5) return { status: 'present', detail: 'ออกงาน 16:00' };
    if (totalMin <= 9 * 60 + 5) return { status: 'present', detail: 'ออกงาน 17:00' };
    if (totalMin <= 10 * 60 + 5) return { status: 'present', detail: 'ออกงาน 18:00' };
    if (totalMin <= 10 * 60 + 20) return { status: 'late', detail: 'สาย (ออกงาน 18:00)' };
    return { status: 'absent', detail: 'ขาดงาน (เกิน 10:20 น.)' };
  }

  // กะปกติ
  if (totalMin <= 9 * 60) return { status: 'present', detail: 'เข้างานตรงเวลา' };
  if (totalMin <= 9 * 60 + 9) return { status: 'present', detail: 'เกือบสาย' };
  if (totalMin <= 9 * 60 + 19) return { status: 'late', detail: 'สาย' };
  return { status: 'absent', detail: 'ขาดงาน' };
};

// POST /api/attendance/check-in
const checkIn = async (req, res) => {
  try {
    const { lat, lng, method = 'gps' } = req.body;
    const today = dayjs().format('YYYY-MM-DD');
    const now = dayjs();

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

    // คำนวณสถานะ
    const { status, detail } = calcStatus(now, emp.shift_type);

    // บันทึก
    const result = await query(
      `INSERT INTO attendance_logs
        (employee_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance_m, check_in_method, status, status_detail)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)
       ON CONFLICT (employee_id, date) DO UPDATE SET
        check_in_at = NOW(), check_in_lat = $3, check_in_lng = $4,
        check_in_distance_m = $5, check_in_method = $6, status = $7, status_detail = $8, updated_at = NOW()
       RETURNING *`,
      [emp.id, today, lat, lng, distanceM, method, status, detail]
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
const getToday = async (req, res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });

    const result = await query(
      'SELECT * FROM attendance_logs WHERE employee_id = $1 AND date = $2',
      [empResult.rows[0].id, today]
    );
    res.json({ success: true, data: result.rows[0] || null });
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
    const present = logs.rows.filter(r => r.status === 'present').length;
    const late = logs.rows.filter(r => r.status === 'late').length;
    const absent = logs.rows.filter(r => r.status === 'absent').length;
    const onLeave = logs.rows.filter(r => r.status === 'leave').length;

    res.json({
      success: true,
      data: {
        date,
        summary: {
          total: totalEmp,
          present,
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
      present: result.rows.filter(r => r.status === 'present').length,
      late: result.rows.filter(r => r.status === 'late').length,
      absent: result.rows.filter(r => r.status === 'absent').length,
      totalWorkHours: result.rows.reduce((s, r) => s + (parseFloat(r.work_hours) || 0), 0).toFixed(1),
      totalOtHours: result.rows.reduce((s, r) => s + (parseFloat(r.ot_hours) || 0), 0).toFixed(1),
    };

    res.json({ success: true, data: { summary, records: result.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = { checkIn, checkOut, getToday, getDailySummary, getMyHistory };
