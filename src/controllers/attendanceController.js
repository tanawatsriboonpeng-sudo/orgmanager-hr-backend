const { query } = require('../../config/database');
const geolib = require('geolib');
const dayjs = require('dayjs');
const { notify, notifyManyByRole, userIdFromEmployee } = require('../middleware/notify');
// Render runs in UTC by default, so a bare dayjs() returns the wrong
// hour-of-day for status calculation (the user's 10:18 reads as 03:18
// at the server and gets bucketed as "ตรงเวลา"). Anchor everything
// time-of-day-sensitive to Asia/Bangkok via the timezone plugin so the
// shift thresholds compare against the user's wall-clock time.
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.APP_TIMEZONE || 'Asia/Bangkok';
const nowLocal = () => dayjs().tz(TZ);

const COMPANY_LAT = parseFloat(process.env.COMPANY_LAT || '13.7563');
const COMPANY_LNG = parseFloat(process.env.COMPANY_LNG || '100.5018');
const MAX_RADIUS = parseInt(process.env.CHECKIN_RADIUS_METERS || '60');

// Multi-location check-in: walk the owner-managed office_locations
// table; the entry is allowed if any active row matches its own radius.
// Returns the closest match (regardless of pass/fail) plus the overall
// pass/fail decision so the caller can surface a useful error message.
// Falls back to the env vars when the table is empty so a fresh install
// still works without HR having to seed anything.
async function checkAllowedLocation(lat, lng) {
  const r = await query(
    `SELECT id, name, lat::float AS lat, lng::float AS lng, radius_meters
       FROM office_locations
      WHERE is_active = true`
  );
  if (r.rows.length === 0) {
    const distance = geolib.getDistance(
      { latitude: lat, longitude: lng },
      { latitude: COMPANY_LAT, longitude: COMPANY_LNG }
    );
    return {
      allowed: distance <= MAX_RADIUS,
      distance,
      radius: MAX_RADIUS,
      matchedName: 'สำนักงาน',
      matchedId: null,
    };
  }
  let closest = { distance: Infinity, location: null };
  let allowed = false;
  for (const loc of r.rows) {
    const d = geolib.getDistance(
      { latitude: lat, longitude: lng },
      { latitude: loc.lat, longitude: loc.lng }
    );
    if (d <= loc.radius_meters) allowed = true;
    if (d < closest.distance) closest = { distance: d, location: loc };
  }
  return {
    allowed,
    distance: closest.distance,
    radius: closest.location?.radius_meters || MAX_RADIUS,
    matchedName: closest.location?.name || 'สำนักงาน',
    matchedId: closest.location?.id || null,
  };
}

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
    const { lat, lng, method = 'gps', selfie, offsite, reason } = req.body;
    const now = nowLocal();
    const today = now.format('YYYY-MM-DD');

    // Selfie size guard. Frontend webcam path produces ~50-100KB at
    // 480px JPEG 0.7, but iPhone Pro HDR photos uploaded from the
    // gallery can be 800KB+. ~1.5MB binary (2MB base64) keeps the row
    // small enough not to hurt query speed while not nagging legit
    // uploads. Same cap is mirrored in the leave-doc + backdate
    // attachment guards.
    if (selfie && typeof selfie === 'string' && selfie.length > 2 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: 'รูปเซลฟี่ใหญ่เกินไป (สูงสุด ~1.5MB)' });
    }

    // Off-site path: HR/owner approves later; we skip the GPS radius
    // check but still require a reason, a selfie, AND valid GPS coords
    // so HR has the full picture when reviewing. Status is computed
    // normally so HR sees what bucket it would have landed in;
    // offsite_status='pending' until approved.
    if (offsite) {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลที่ลงเวลานอกสถานที่' });
      }
      if (!selfie) {
        return res.status(400).json({ success: false, message: 'กรุณาถ่ายเซลฟี่ประกอบการลงเวลานอกสถานที่' });
      }
      // GPS is mandatory even for off-site — the whole point is for HR
      // to verify *where* the employee actually was. Without coords the
      // distance to office is null and there's no way to validate.
      if (!lat || !lng) {
        return res.status(400).json({
          success: false,
          message: 'กรุณาเปิด GPS — ลงเวลานอกสถานที่ต้องระบุตำแหน่งจริงเพื่อให้ HR ตรวจสอบ',
        });
      }
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

    // ตรวจสอบ GPS — off-site path skips the radius check (the whole
    // point is to log a check-in from outside), but still records the
    // closest-location distance so HR sees how far the employee was
    // when reviewing the offsite request.
    let distanceM = null;
    let allowedLoc = null;
    if (method === 'gps' && lat && lng) {
      allowedLoc = await checkAllowedLocation(lat, lng);
      distanceM = allowedLoc.distance;
    }
    if (!offsite && method === 'gps') {
      if (!lat || !lng) {
        return res.status(400).json({ success: false, message: 'กรุณาเปิด GPS' });
      }
      if (!allowedLoc?.allowed) {
        return res.status(400).json({
          success: false,
          message: `อยู่นอกรัศมีที่ตั้งสำนักงาน (ใกล้สุด: ${allowedLoc.matchedName} ${distanceM} ม. / รัศมี ${allowedLoc.radius} ม.)`,
          data: { distance: distanceM, maxRadius: allowedLoc.radius, matchedLocation: allowedLoc.matchedName }
        });
      }
    }

    // Resolve the active shift config for today and compute status from it.
    // This honors the weekly schedule + the rules HR set in /shifts (work_start,
    // late thresholds, flex tiers), instead of the previous hardcoded 9:00.
    //
    // Day-off blocks BOTH normal and off-site check-ins. If a manager
    // genuinely needs the employee to work on their day off, the right
    // path is to update the weekly_shifts entry first (or use /ot for
    // an explicit off-hours request) — letting off-site bypass would
    // let the employee silently log "work" on a day they're not even
    // scheduled, which payroll would then have to untangle.
    const { config: shiftCfg, isDayOff } = await resolveShiftConfig(emp.id, today);
    if (isDayOff) {
      return res.status(400).json({
        success: false,
        message: offsite
          ? 'วันนี้เป็นวันหยุดของคุณ — ติดต่อ HR เพื่อปรับตารางก่อนลงเวลา'
          : 'วันนี้เป็นวันหยุดของคุณ ไม่ต้องลงเวลา',
      });
    }
    const { status, detail, almostLate } = calcStatus(now, shiftCfg);

    // บันทึก
    const offsiteFlag = !!offsite;
    const offsiteStatus = offsiteFlag ? 'pending' : null;
    const result = await query(
      `INSERT INTO attendance_logs
        (employee_id, date, check_in_at, check_in_lat, check_in_lng, check_in_distance_m, check_in_method,
         status, status_detail, check_in_selfie, almost_late,
         is_offsite, offsite_reason, offsite_status)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (employee_id, date) DO UPDATE SET
        check_in_at = NOW(), check_in_lat = $3, check_in_lng = $4,
        check_in_distance_m = $5, check_in_method = $6, status = $7, status_detail = $8,
        check_in_selfie = COALESCE($9, attendance_logs.check_in_selfie),
        almost_late = $10,
        is_offsite      = $11,
        offsite_reason  = COALESCE($12, attendance_logs.offsite_reason),
        offsite_status  = $13,
        updated_at = NOW()
       RETURNING *`,
      [emp.id, today, lat, lng, distanceM, method,
       status, detail, selfie || null, !!almostLate,
       offsiteFlag, offsiteFlag ? String(reason).trim() : null, offsiteStatus]
    );

    // Off-site submission is the trigger that HR/owner need a heads-up
    // for; a normal in-radius check-in is self-service and doesn't need
    // to wake anyone up. We look up the employee's display name so the
    // bell entry reads naturally instead of "พนักงาน".
    if (offsiteFlag) {
      const nameRow = await query(
        `SELECT CONCAT(first_name, ' ', last_name) AS n FROM employees WHERE id = $1`,
        [emp.id]
      ).catch(() => ({ rows: [] }));
      const empName = nameRow.rows[0]?.n || 'พนักงาน';
      const distanceTxt = distanceM != null
        ? `ห่างออฟฟิศ ${(distanceM / 1000).toFixed(1)} กม.`
        : 'ไม่ระบุระยะ';
      notifyManyByRole(['hr', 'owner'], {
        type: 'attendance_offsite_pending',
        title: `คำขอลงเวลานอกสถานที่จาก ${empName}`,
        body: `${now.format('HH:mm')} · ${distanceTxt} · เหตุผล: ${String(reason).trim().slice(0, 80)}`,
        link: '/attendance',
        relatedId: result.rows[0].id,
      });
    }

    res.json({
      success: true,
      message: offsiteFlag
        ? 'ส่งคำขอลงเวลานอกสถานที่แล้ว รอ HR/เจ้าของอนุมัติ'
        : `เช็คอินสำเร็จ — ${detail}`,
      data: {
        checkInAt: result.rows[0].check_in_at,
        status,
        statusDetail: detail,
        distance: distanceM,
        offsite: offsiteFlag,
        offsiteStatus,
      }
    });
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// Check-out status bucket — descriptive label only.
// 'overtime' here = "stayed past work_end," NOT approved OT; payroll
// still pulls real OT hours from approved ot_requests.
function calcCheckOutStatus(now, cfg) {
  if (!cfg || !cfg.work_end) {
    return { status: 'on_time', detail: 'ออกงาน' };
  }
  const totalMin = now.hour() * 60 + now.minute();
  const workEnd = timeToMin(cfg.work_end);
  // 5-minute grace either side of work_end so a clock-skewed device
  // doesn't land in "ออกก่อนเวลา" at exactly work_end.
  const ON_TIME_GRACE = 5;
  if (totalMin < workEnd - ON_TIME_GRACE) {
    return { status: 'early',    detail: 'ออกก่อนเวลา' };
  }
  if (totalMin <= workEnd + ON_TIME_GRACE) {
    return { status: 'on_time',  detail: 'ออกตรงเวลา' };
  }
  return { status: 'overtime',   detail: 'อยู่หลังเวลาเลิกงาน' };
}

// POST /api/attendance/check-out
//
// Hardened to mirror check-in: requires a selfie + GPS, validates the
// radius (with an offsite-reason escape hatch the same way check-in
// does), and rejects "too soon after check-in" via shift_configs
// .min_work_minutes (default 30). Stores a descriptive checkout
// status (early / on_time / overtime) so HR can spot pattern leavers
// without manually comparing timestamps.
const checkOut = async (req, res) => {
  try {
    const { lat, lng, method = 'gps', selfie, offsite, reason } = req.body;
    const today = nowLocal().format('YYYY-MM-DD');

    // Selfie size guard — same cap as check-in for consistency.
    if (selfie && typeof selfie === 'string' && selfie.length > 2 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: 'รูปเซลฟี่ใหญ่เกินไป (สูงสุด ~1.5MB)' });
    }
    if (!selfie) {
      return res.status(400).json({ success: false, message: 'กรุณาถ่ายเซลฟี่ก่อนเช็คเอาท์' });
    }

    // Off-site path: same rules as check-in — reason + selfie + valid
    // GPS coords so HR can verify where the employee actually was.
    if (offsite) {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลที่เช็คเอาท์นอกสถานที่' });
      }
      if (!lat || !lng) {
        return res.status(400).json({
          success: false,
          message: 'กรุณาเปิด GPS — เช็คเอาท์นอกสถานที่ต้องระบุตำแหน่งจริงเพื่อให้ HR ตรวจสอบ',
        });
      }
    }

    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;

    const log = await query(
      'SELECT * FROM attendance_logs WHERE employee_id = $1 AND date = $2',
      [empId, today]
    );
    if (!log.rows[0]) return res.status(400).json({ success: false, message: 'ยังไม่ได้เช็คอินวันนี้' });
    // Leave-approval + admin attendance writes can create a row with
    // status='leave' and no check_in_at. Without this guard, dayjs(null)
    // → invalid → elapsedMin = NaN → bypasses the min-work check AND
    // persists work_hours = NaN to the DB, poisoning bulk-generate later.
    if (!log.rows[0].check_in_at) {
      return res.status(400).json({ success: false, message: 'ยังไม่ได้เช็คอินวันนี้' });
    }
    if (log.rows[0].check_out_at) return res.status(409).json({ success: false, message: 'เช็คเอาท์วันนี้แล้ว' });

    // GPS radius — same logic + escape hatch as check-in.
    let distanceM = null;
    let allowedLoc = null;
    if (method === 'gps' && lat && lng) {
      allowedLoc = await checkAllowedLocation(lat, lng);
      distanceM = allowedLoc.distance;
    }
    if (!offsite && method === 'gps') {
      if (!lat || !lng) {
        return res.status(400).json({ success: false, message: 'กรุณาเปิด GPS' });
      }
      if (!allowedLoc?.allowed) {
        return res.status(400).json({
          success: false,
          message: `อยู่นอกรัศมีที่ตั้งสำนักงาน (ใกล้สุด: ${allowedLoc.matchedName} ${distanceM} ม. / รัศมี ${allowedLoc.radius} ม.)`,
          data: { distance: distanceM, maxRadius: allowedLoc.radius, matchedLocation: allowedLoc.matchedName }
        });
      }
    }

    const checkInAt = dayjs(log.rows[0].check_in_at);
    const checkOutAt = nowLocal();

    // Resolve today's shift config so we can both (a) enforce the
    // min-work-minutes floor and (b) compute the checkout status.
    //
    // Default lowered from 30 → 5: the 30-minute floor was blocking
    // legit early-leavers (sick, family emergency, manager said go
    // home) and pushing them to ask HR to fix the record. 5 minutes
    // is still enough to catch the "tap in, immediately tap out by
    // mistake" pattern that motivated this guard. HR can raise the
    // floor per shift via shift_configs.min_work_minutes if their
    // policy is stricter.
    const { config: shiftCfg } = await resolveShiftConfig(empId, today);
    const minWorkMin = shiftCfg?.min_work_minutes ?? 5;
    const elapsedMin = checkOutAt.diff(checkInAt, 'minute');
    if (elapsedMin < minWorkMin) {
      return res.status(400).json({
        success: false,
        message: `เพิ่งเช็คอินไป ${elapsedMin} นาที — ต้องอย่างน้อย ${minWorkMin} นาทีก่อนเช็คเอาท์ (ถ้าต้องออกเร็วกรุณายื่นลา)`,
      });
    }

    const workHours = parseFloat((checkOutAt.diff(checkInAt, 'minute') / 60).toFixed(2));
    const { status: checkOutStatus } = calcCheckOutStatus(checkOutAt, shiftCfg);

    // OT stays 0 here — see comment on the previous version. Real OT
    // is approved /ot/request rows summed by payroll bulk-generate.
    //
    // Offsite *checkout* is informational only — the employee already
    // checked in earlier (which was validated/approved as needed), so
    // leaving from outside the radius isn't something HR needs to
    // approve. We log the flag + reason for audit, but skip the
    // pending queue (different from offsite check-in, where approval
    // gates the "did they actually work today?" question).
    const offsiteFlag = !!offsite;
    const offsiteStatus = offsiteFlag ? 'logged' : null;
    await query(
      `UPDATE attendance_logs SET
        check_out_at = NOW(),
        check_out_lat = $1, check_out_lng = $2,
        check_out_distance_m = $3,
        check_out_method = $4,
        check_out_selfie = $5,
        check_out_status = $6,
        check_out_is_offsite = $7,
        check_out_offsite_reason = $8,
        check_out_offsite_status = $9,
        work_hours = $10,
        ot_hours = 0,
        updated_at = NOW()
       WHERE employee_id = $11 AND date = $12`,
      [
        lat, lng, distanceM, method, selfie,
        checkOutStatus,
        offsiteFlag, offsiteFlag ? String(reason).trim() : null, offsiteStatus,
        workHours, empId, today
      ]
    );

    // No HR notification for offsite checkout — it's audit-only.
    // (See comment above on offsiteStatus = 'logged'.)

    res.json({
      success: true,
      message: 'เช็คเอาท์สำเร็จ',
      data: {
        checkOutAt: checkOutAt.toISOString(),
        workHours,
        otHours: 0,
        checkOutStatus,
      }
    });
  } catch (err) {
    // Surface the real cause in the response so the user can tell
    // us what's failing without trawling Render logs. Endpoint is
    // employee-self-only (uses req.user.id implicitly), so there's
    // no PII risk in echoing the message.
    console.error('POST /attendance/check-out error:', err);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${err.message}` });
  }
};

// GET /api/attendance/today
// Also returns the active shift info so the UI can render the expected
// work_start time + countdown ("เหลือ N นาทีก่อนสาย") without a
// second round-trip to /shift-configs.
const getToday = async (req, res) => {
  try {
    const today = nowLocal().format('YYYY-MM-DD');
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
    // Lazy housekeeping: process any past-day "checked-in but no
    // check-out" rows before computing the summary, so the work_hours
    // figures HR sees already reflect the policy. Awaited so the
    // summary picks up the freshly-written work_hours.
    await sweepMissingCheckouts().catch(err =>
      console.error('[daily-summary] sweep failed:', err.message)
    );
    const date = req.query.date || nowLocal().format('YYYY-MM-DD');

    // Three changes from the old query:
    //   1. Roster EXCLUDES owners — they're blocked from check-in by
    //      blockOwner middleware, so counting them inflated the total
    //      and made every owner a permanent "ยังไม่เข้า" entry.
    //   2. Pull weekly_shifts so we can tag each person's dayoff
    //      status for the requested date — a dayoff employee correctly
    //      not checking in shouldn't drag attendance_rate to 0.
    //   3. Return the full roster (not just the people who checked
    //      in) so the small-company dashboard can render a named-list
    //      view of everyone with their status today.
    const dowKey = String(dayjs(date).day());
    const [roster, logs, holidays, shifts] = await Promise.all([
      query(
        `SELECT e.id, e.first_name, e.last_name, e.nickname, e.avatar_url,
                e.employee_id AS emp_code, e.position, e.shift_type,
                e.weekly_shifts,
                u.role AS user_role,
                d.name AS department_name
           FROM employees e
           JOIN users u ON e.user_id = u.id
           LEFT JOIN departments d ON e.department_id = d.id
          WHERE e.is_active = true
            AND u.is_active = true
            AND u.role <> 'owner'
          ORDER BY e.first_name, e.last_name`
      ),
      query(
        `SELECT a.*, e.first_name, e.last_name, e.nickname, e.avatar_url,
                e.employee_id as emp_code,
                d.name as department, e.shift_type
         FROM attendance_logs a
         JOIN employees e ON a.employee_id = e.id
         LEFT JOIN departments d ON e.department_id = d.id
         WHERE a.date = $1
         ORDER BY a.check_in_at ASC NULLS LAST`,
        [date]
      ),
      // Holidays table may not be populated yet — empty array on miss
      // keeps the rest of the function working unchanged.
      query(
        `SELECT id, name, type FROM holidays WHERE date = $1`,
        [date]
      ).catch(() => ({ rows: [] })),
      // Active shift configs so the dashboard can render each person's
      // "กะเริ่ม HH:MM" hint without a second round-trip. Cheap — ~3-5
      // rows tops in a typical install.
      query(
        `SELECT code, shift_type, work_start, work_end
           FROM shift_configs
          WHERE is_active = true`
      ).catch(() => ({ rows: [] })),
    ]);

    const todaysHoliday = holidays.rows[0] || null;
    // Tag the roster: per-person "should they be working today?"
    // Used both for the notCheckedIn count (skip dayoff/holiday) and
    // exposed to the frontend so the person-list view can render
    // appropriate badges instead of a red "ยังไม่เข้า" pill.
    const rosterTagged = roster.rows.map(emp => {
      const ws = emp.weekly_shifts || {};
      return {
        ...emp,
        is_day_off:   ws[dowKey] === 'dayoff',
        is_holiday:   !!todaysHoliday,
        holiday_name: todaysHoliday?.name || null,
      };
    });

    // A rejected off-site check-in is treated as if the employee never
    // checked in — they go back into the "ยังไม่เข้า" bucket and don't
    // count toward present/late/etc. The original row is still here so
    // it can be surfaced as a separate "ปฏิเสธ" group for HR awareness.
    const isRejectedOffsite = r => r.is_offsite && r.offsite_status === 'rejected';
    const counted  = logs.rows.filter(r => !isRejectedOffsite(r));
    const rejected = logs.rows.filter(isRejectedOffsite);
    const checkedInIds = new Set(counted.map(r => r.employee_id));

    // Working denominator = roster minus dayoffs minus holidays, so
    // attendance_rate reflects "did the people who were SUPPOSED to
    // work actually show up?" instead of penalizing the schedule.
    const expectedToWork = rosterTagged.filter(r => !r.is_day_off && !r.is_holiday);
    const totalEmp = rosterTagged.length;       // for headline "พนักงาน N คน"
    const expectedEmp = expectedToWork.length;  // for the rate denominator

    const present    = counted.filter(r => r.status === 'present').length;
    const almostLate = counted.filter(r => r.status === 'present' && r.almost_late).length;
    const late       = counted.filter(r => r.status === 'late').length;
    const absent     = counted.filter(r => r.status === 'absent').length;
    const onLeave    = counted.filter(r => r.status === 'leave').length;
    // notCheckedIn excludes dayoff + holiday people so a Saturday
    // doesn't read as "everyone's missing." Also excludes anyone
    // already represented by a counted row.
    const notCheckedIn = expectedToWork.filter(r => !checkedInIds.has(r.id)).length;

    res.json({
      success: true,
      data: {
        date,
        holiday: todaysHoliday,  // null on a normal weekday
        summary: {
          total: totalEmp,
          expected: expectedEmp,
          present,
          almostLate,
          late,
          absent,
          leave: onLeave,
          rejected: rejected.length,
          notCheckedIn,
          // Guard divide-by-zero — a brand-new install with zero
          // active employees would otherwise return NaN.
          attendanceRate: expectedEmp > 0
            ? parseFloat(((present + late) / expectedEmp * 100).toFixed(1))
            : 0
        },
        // Full named roster so the frontend can render a per-person
        // status list (no need for a second /employees call).
        roster: rosterTagged,
        records: counted,
        rejectedRecords: rejected,
        // Active shift configs keyed by code for the per-person "กะเริ่ม"
        // hint in the dashboard's roster. Frontend looks up the employee's
        // weekly_shifts[dow] code, falls back to first active config of
        // their shift_type, then a hardcoded 09:00.
        shifts: shifts.rows,
      }
    });
  } catch (err) {
    console.error('GET /attendance/daily-summary error:', err.message);
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
    const end = nowLocal();

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

    // Pull both stats AND holiday rows in parallel. The holiday lookup
    // is empty-tolerant so a missing/legacy table doesn't kill the
    // chart — it just won't get holiday markers.
    const [result, holidayRes] = await Promise.all([
      query(
        `SELECT date::text AS d,
                COUNT(*) FILTER (WHERE status = 'present' AND NOT almost_late)::int AS present,
                COUNT(*) FILTER (WHERE status = 'present' AND almost_late)::int     AS almost_late,
                COUNT(*) FILTER (WHERE status = 'late')::int                        AS late,
                COUNT(*) FILTER (WHERE status = 'absent')::int                      AS absent,
                COUNT(*) FILTER (WHERE status = 'leave')::int                       AS leave,
                COUNT(*) FILTER (WHERE status = 'very_late')::int                   AS very_late
           FROM attendance_logs
          WHERE date BETWEEN $1 AND $2
            AND NOT (is_offsite = true AND offsite_status = 'rejected')
          GROUP BY date`,
        [start, stop]
      ),
      query(
        `SELECT date::text AS d, name FROM holidays
          WHERE date BETWEEN $1 AND $2`,
        [start, stop]
      ).catch(() => ({ rows: [] })),
    ]);
    const byDate = {};
    for (const r of result.rows) byDate[r.d] = r;
    const holidayByDate = {};
    for (const h of holidayRes.rows) holidayByDate[h.d] = h.name;

    // Thai single-char day labels (Sun..Sat) to match the dashboard's
    // existing axis style: อา / จ / อ / พ / พฤ / ศ / ส.
    const DAY_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
    const rows = dates.map(d => {
      const dow = dayjs(d).day();
      const row = byDate[d] || { present: 0, almost_late: 0, late: 0, absent: 0, leave: 0, very_late: 0 };
      const holidayName = holidayByDate[d] || null;
      return {
        date: d,
        day: DAY_TH[dow],
        present: row.present,                       // ตรงเวลาเป๊ะ (not almost_late)
        almost_late: row.almost_late,               // เกือบสาย — own bar so dashboard can show it
        late: row.late + row.very_late,             // collapse very_late into late
        absent: row.absent,
        leave: row.leave,
        // Per-day holiday marker so the chart can render a label/tint
        // instead of a misleading "everyone absent" bar.
        is_holiday: !!holidayName,
        holiday_name: holidayName,
      };
    });

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /attendance/recent-summary error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/offsite-pending — HR/owner queue of off-site
// check-ins awaiting approval. Joins employee + computes how far they
// were from the office at submission time so HR can sanity-check the
// reason.
const getOffsitePending = async (req, res) => {
  try {
    const r = await query(
      `SELECT a.id, a.date, a.check_in_at, a.check_in_lat, a.check_in_lng,
              a.check_in_distance_m, a.check_in_selfie, a.status, a.status_detail,
              a.offsite_reason, a.offsite_status,
              e.id AS employee_id, e.first_name, e.last_name, e.nickname,
              e.avatar_url, e.employee_id AS emp_code, e.position,
              d.name AS department_name
         FROM attendance_logs a
         JOIN employees e ON a.employee_id = e.id
         LEFT JOIN departments d ON e.department_id = d.id
        WHERE a.is_offsite = true AND a.offsite_status = 'pending'
        ORDER BY a.check_in_at ASC`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('GET /attendance/offsite-pending error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/attendance/offsite/:id/approve — HR/owner stamps approval.
// Row stays as a normal attendance_logs entry; only offsite_status flips
// from 'pending' to 'approved' so payroll/stats can include it.
const approveOffsite = async (req, res) => {
  try {
    const r = await query(
      `UPDATE attendance_logs
          SET offsite_status      = 'approved',
              offsite_approved_by = $1,
              offsite_approved_at = NOW(),
              updated_at          = NOW()
        WHERE id = $2
          AND is_offsite = true
          AND offsite_status = 'pending'
        RETURNING id, employee_id, date, check_in_at`,
      [req.user.id, req.params.id]
    );
    if (!r.rows[0]) {
      return res.status(400).json({ success: false, message: 'อนุมัติได้เฉพาะคำขอที่รออนุมัติ' });
    }
    // Notify the employee that their request landed.
    const row = r.rows[0];
    const empUserId = await userIdFromEmployee(row.employee_id);
    notify(empUserId, {
      type: 'attendance_offsite_approved',
      title: 'อนุมัติการลงเวลานอกสถานที่ของคุณแล้ว',
      body: `วันที่ ${dayjs(row.date).format('D MMM')} · เช็คอินเวลา ${dayjs(row.check_in_at).format('HH:mm')}`,
      link: '/attendance',
      relatedId: row.id,
    });
    res.json({ success: true, message: 'อนุมัติการลงเวลานอกสถานที่แล้ว' });
  } catch (err) {
    console.error('POST /attendance/offsite/:id/approve error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/attendance/offsite/:id/reject — HR/owner rejects with an
// optional reason. We keep the row in attendance_logs (status=rejected)
// rather than deleting so audit history sticks around; payroll/stats
// filter rejected rows out by checking offsite_status.
const rejectOffsite = async (req, res) => {
  try {
    const { reason } = req.body;
    const cleanReason = reason ? String(reason).trim() : null;
    const r = await query(
      `UPDATE attendance_logs
          SET offsite_status        = 'rejected',
              offsite_approved_by   = $1,
              offsite_approved_at   = NOW(),
              offsite_reject_reason = $2,
              updated_at            = NOW()
        WHERE id = $3
          AND is_offsite = true
          AND offsite_status = 'pending'
        RETURNING id, employee_id, date, check_in_at`,
      [req.user.id, cleanReason, req.params.id]
    );
    if (!r.rows[0]) {
      return res.status(400).json({ success: false, message: 'ปฏิเสธได้เฉพาะคำขอที่รออนุมัติ' });
    }
    // Notify the employee with the reason inline (so they see *why*
    // without having to open the page).
    const row = r.rows[0];
    const empUserId = await userIdFromEmployee(row.employee_id);
    const bodyParts = [`วันที่ ${dayjs(row.date).format('D MMM')} · เช็คอินเวลา ${dayjs(row.check_in_at).format('HH:mm')}`];
    if (cleanReason) bodyParts.push(`หมายเหตุ: ${cleanReason}`);
    notify(empUserId, {
      type: 'attendance_offsite_rejected',
      title: 'ไม่อนุมัติการลงเวลานอกสถานที่ของคุณ',
      body: bodyParts.join(' · '),
      link: '/attendance',
      relatedId: row.id,
    });
    res.json({ success: true, message: 'ปฏิเสธการลงเวลานอกสถานที่แล้ว' });
  } catch (err) {
    console.error('POST /attendance/offsite/:id/reject error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/my-history?month=5&year=2025
const getMyHistory = async (req, res) => {
  try {
    const { month, year } = req.query;
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;
    const m = month || nowLocal().month() + 1;
    const y = year || nowLocal().year();

    // Pull attendance + approved OT in parallel. OT is the source-of-
    // truth column on ot_requests, not attendance_logs.ot_hours (which
    // is now always 0 per the "auto OT removed" policy).
    const [result, otRes] = await Promise.all([
      query(
        `SELECT * FROM attendance_logs
         WHERE employee_id = $1
           AND EXTRACT(MONTH FROM date) = $2
           AND EXTRACT(YEAR FROM date) = $3
         ORDER BY date DESC`,
        [empId, m, y]
      ),
      query(
        `SELECT COALESCE(SUM(hours), 0)::float AS hours, COUNT(*)::int AS request_count
           FROM ot_requests
          WHERE employee_id = $1
            AND status = 'hr_approved'
            AND EXTRACT(MONTH FROM date) = $2
            AND EXTRACT(YEAR FROM date) = $3`,
        [empId, m, y]
      ),
    ]);

    // Rejected off-site requests don't contribute to the personal totals;
    // the rows stay in `records` so the employee can still see them with
    // the rejected badge.
    const counted = result.rows.filter(r => !(r.is_offsite && r.offsite_status === 'rejected'));
    const summary = {
      present:    counted.filter(r => r.status === 'present').length,
      almostLate: counted.filter(r => r.status === 'present' && r.almost_late).length,
      late:       counted.filter(r => r.status === 'late').length,
      absent:     counted.filter(r => r.status === 'absent').length,
      // Leave count was missing — the summary now reflects all four
      // attendance buckets the UI shows.
      leave:      counted.filter(r => r.status === 'leave').length,
      totalWorkHours: counted.reduce((s, r) => s + (parseFloat(r.work_hours) || 0), 0).toFixed(1),
      // OT total comes from approved /ot/request rows in this month.
      // attendance_logs.ot_hours is never auto-populated anymore.
      totalOtHours:    (otRes.rows[0]?.hours || 0).toFixed(1),
      otRequestCount:  otRes.rows[0]?.request_count || 0,
    };

    res.json({ success: true, data: { summary, records: result.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== Backdated check-in / check-out requests ===== */
// Employee forgot to tap เช็คอิน/เช็คเอาท์ on a past day → submits a
// request with the actual time + reason. Kept in its own table so the
// audit trail is preserved even after HR's approval writes the
// attendance_logs row.

// POST /api/attendance/backdate-request
const createBackdateRequest = async (req, res) => {
  if (req.user?.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องยื่นคำขอลงเวลา' });
  }
  const { date, requestType, checkInTime, checkOutTime, reason, attachment } = req.body;
  if (!date || !requestType || !reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุวันที่ ประเภท และเหตุผล' });
  }
  // Optional attachment cap — same ~1.5MB rule as the selfie field.
  if (attachment && typeof attachment === 'string' && attachment.length > 2 * 1024 * 1024) {
    return res.status(413).json({ success: false, message: 'รูปหลักฐานใหญ่เกินไป (สูงสุด ~1.5MB)' });
  }
  if (!['check_in', 'check_out', 'both'].includes(requestType)) {
    return res.status(400).json({ success: false, message: 'ประเภทคำขอไม่ถูกต้อง' });
  }
  // Each request_type needs its corresponding time field. Validation here
  // saves a noisy approval failure later when HR tries to apply it.
  if ((requestType === 'check_in' || requestType === 'both') && !checkInTime) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุเวลาเข้างาน' });
  }
  if ((requestType === 'check_out' || requestType === 'both') && !checkOutTime) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุเวลาออกงาน' });
  }
  // Sanity: can't submit a request for a future date.
  if (dayjs(date).isAfter(nowLocal(), 'day')) {
    return res.status(400).json({ success: false, message: 'ไม่สามารถยื่นย้อนหลังในวันอนาคตได้' });
  }
  try {
    const emp = await query('SELECT id, first_name, last_name FROM employees WHERE user_id = $1', [req.user.id]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empRow = emp.rows[0];

    const r = await query(
      `INSERT INTO attendance_backdate_requests
         (employee_id, date, request_type, check_in_time, check_out_time, reason, attachment)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [empRow.id, date, requestType,
       requestType === 'check_out' ? null : (checkInTime  || null),
       requestType === 'check_in'  ? null : (checkOutTime || null),
       String(reason).trim(),
       attachment || null]
    );

    // Notify everyone who can approve. The body packs the date + the
    // first 60 chars of the reason so the bell row reads naturally.
    const typeTxt = requestType === 'both'        ? 'เข้า+ออกงาน'
                  : requestType === 'check_in'    ? 'เข้างาน'
                  :                                  'ออกงาน';
    notifyManyByRole(['hr', 'owner'], {
      type: 'attendance_backdate_pending',
      title: `คำขอลงเวลาย้อนหลัง (${typeTxt}) จาก ${empRow.first_name} ${empRow.last_name}`,
      body: `วันที่ ${dayjs(date).format('D MMM')} · เหตุผล: ${String(reason).trim().slice(0, 60)}`,
      link: '/attendance',
      relatedId: r.rows[0].id,
    });

    res.status(201).json({ success: true, message: 'ส่งคำขอลงเวลาย้อนหลังแล้ว รอ HR/เจ้าของอนุมัติ', data: r.rows[0] });
  } catch (err) {
    console.error('POST /attendance/backdate-request error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/backdate-pending (HR/owner)
const getBackdatePending = async (req, res) => {
  try {
    const r = await query(
      `SELECT br.*,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id AS emp_code, e.position,
              d.name AS department_name
         FROM attendance_backdate_requests br
         JOIN employees e ON br.employee_id = e.id
         LEFT JOIN departments d ON e.department_id = d.id
        WHERE br.status = 'pending'
        ORDER BY br.created_at ASC`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('GET /attendance/backdate-pending error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/attendance/backdate-mine — employee sees their own history
const getMyBackdateRequests = async (req, res) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!emp.rows[0]) return res.json({ success: true, data: [] });
    const r = await query(
      `SELECT * FROM attendance_backdate_requests
        WHERE employee_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [emp.rows[0].id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('GET /attendance/backdate-mine error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/attendance/backdate/:id/approve — HR/owner approves.
// Applies the request to attendance_logs: insert or update the (employee,
// date) row to reflect the requested check_in_at / check_out_at. Status
// is recomputed via calcStatus so the bucket matches what would have
// happened if they'd checked in on time.
const approveBackdate = async (req, res) => {
  try {
    const reqRow = await query(
      `SELECT br.*, e.id AS emp_id
         FROM attendance_backdate_requests br
         JOIN employees e ON br.employee_id = e.id
        WHERE br.id = $1 AND br.status = 'pending'`,
      [req.params.id]
    );
    if (!reqRow.rows[0]) {
      return res.status(400).json({ success: false, message: 'อนุมัติได้เฉพาะคำขอที่รออนุมัติ' });
    }
    const br = reqRow.rows[0];
    const date = dayjs(br.date).format('YYYY-MM-DD');

    // Build absolute timestamps from the date + TIME components.
    const stamp = (t) => t ? dayjs.tz(`${date}T${String(t).slice(0,8)}`, TZ).toISOString() : null;
    const wantCheckIn  = (br.request_type === 'check_in' || br.request_type === 'both');
    const wantCheckOut = (br.request_type === 'check_out' || br.request_type === 'both');
    const newCheckInAt  = wantCheckIn  ? stamp(br.check_in_time)  : null;
    const newCheckOutAt = wantCheckOut ? stamp(br.check_out_time) : null;

    // Guard: a check-out-only approval can't create a fresh row, because
    // there'd be no check_in_at to anchor it against. Force-check that an
    // attendance_logs row for this (employee, date) already exists. If
    // not, surface the error to HR so they decide between asking the
    // employee to resubmit as 'both' or rejecting outright. Without
    // this, the INSERT path would happily write a row with
    // check_in_at=NULL + check_out_at=stamp — broken data that breaks
    // work_hours math and the daily summary.
    if (!wantCheckIn) {
      const existingRow = await query(
        'SELECT check_in_at FROM attendance_logs WHERE employee_id = $1 AND date = $2',
        [br.emp_id, date]
      );
      if (!existingRow.rows[0]?.check_in_at) {
        return res.status(400).json({
          success: false,
          message: 'ไม่มีข้อมูลเข้างานในวันนี้ — ขอให้พนักงานยื่นคำขอใหม่แบบ "เข้า+ออกงาน"',
        });
      }
    }

    // Recompute status if we're (re)setting check-in. Use the shift
    // resolver for that date so the bucket matches the employee's
    // schedule.
    let newStatus = null, newDetail = null, newAlmostLate = null;
    if (wantCheckIn) {
      const { config: shiftCfg } = await resolveShiftConfig(br.emp_id, date);
      const checkInAsDay = dayjs.tz(`${date}T${String(br.check_in_time).slice(0,8)}`, TZ);
      const calc = calcStatus(checkInAsDay, shiftCfg);
      newStatus = calc.status; newDetail = calc.detail; newAlmostLate = calc.almostLate;
    }

    // Work hours from check-in → check-out, when both are now present.
    // ot_hours stays 0 — see the policy note in checkOut. OT only counts
    // when there's an approved /ot/request row.
    let workHours = null;
    const otHours = wantCheckOut ? 0 : null;
    if (wantCheckOut) {
      // Need check-in to compute. Use the request's check_in_time when
      // provided, otherwise read the existing row's check_in_at.
      let checkIn;
      if (wantCheckIn) checkIn = dayjs.tz(`${date}T${String(br.check_in_time).slice(0,8)}`, TZ);
      else {
        const existing = await query(
          'SELECT check_in_at FROM attendance_logs WHERE employee_id = $1 AND date = $2',
          [br.emp_id, date]
        );
        if (existing.rows[0]?.check_in_at) checkIn = dayjs(existing.rows[0].check_in_at);
      }
      if (checkIn) {
        const checkOut = dayjs.tz(`${date}T${String(br.check_out_time).slice(0,8)}`, TZ);
        const minutes = checkOut.diff(checkIn, 'minute');
        if (minutes > 0) {
          workHours = parseFloat((minutes / 60).toFixed(2));
        }
      }
    }

    // Apply to attendance_logs. ON CONFLICT updates the existing row;
    // COALESCE keeps fields we didn't touch (so a check-out-only approval
    // doesn't clobber the existing check-in).
    //
    // missing_checkout flag is force-cleared: HR just gave the row a real
    // check-out time, so the "you forgot to tap" banner shouldn't keep
    // showing. Without this, sweepMissingCheckouts' half-day work_hours
    // estimate is overwritten correctly via COALESCE but the boolean
    // sticks around — confusing the UI.
    await query(
      `INSERT INTO attendance_logs
         (employee_id, date, check_in_at, check_out_at, status, status_detail, almost_late, work_hours, ot_hours, check_in_method, missing_checkout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', false)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         check_in_at  = COALESCE($3, attendance_logs.check_in_at),
         check_out_at = COALESCE($4, attendance_logs.check_out_at),
         status        = COALESCE($5, attendance_logs.status),
         status_detail = COALESCE($6, attendance_logs.status_detail),
         almost_late   = COALESCE($7, attendance_logs.almost_late),
         work_hours    = COALESCE($8, attendance_logs.work_hours),
         ot_hours      = COALESCE($9, attendance_logs.ot_hours),
         missing_checkout = false,
         updated_at    = NOW()`,
      [br.emp_id, date, newCheckInAt, newCheckOutAt,
       newStatus, newDetail, newAlmostLate, workHours, otHours]
    );

    await query(
      `UPDATE attendance_backdate_requests
          SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [req.user.id, req.params.id]
    );

    // Notify the employee.
    const empUserId = await userIdFromEmployee(br.emp_id);
    const typeTxt = br.request_type === 'both'     ? 'เข้า+ออกงาน'
                  : br.request_type === 'check_in' ? 'เข้างาน'
                  :                                   'ออกงาน';
    notify(empUserId, {
      type: 'attendance_backdate_approved',
      title: `อนุมัติคำขอลงเวลาย้อนหลัง (${typeTxt})`,
      body: `วันที่ ${dayjs(date).format('D MMM')}`,
      link: '/attendance',
      relatedId: br.id,
    });

    res.json({ success: true, message: 'อนุมัติคำขอแล้ว' });
  } catch (err) {
    console.error('POST /attendance/backdate/:id/approve error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/attendance/backdate/:id/reject — HR/owner rejects with an
// optional reason. attendance_logs is not touched.
const rejectBackdate = async (req, res) => {
  try {
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    const r = await query(
      `UPDATE attendance_backdate_requests
          SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
              reject_reason = $2, updated_at = NOW()
        WHERE id = $3 AND status = 'pending'
        RETURNING id, employee_id, date, request_type`,
      [req.user.id, reason, req.params.id]
    );
    if (!r.rows[0]) {
      return res.status(400).json({ success: false, message: 'ปฏิเสธได้เฉพาะคำขอที่รออนุมัติ' });
    }
    const row = r.rows[0];
    const empUserId = await userIdFromEmployee(row.employee_id);
    const typeTxt = row.request_type === 'both'     ? 'เข้า+ออกงาน'
                  : row.request_type === 'check_in' ? 'เข้างาน'
                  :                                    'ออกงาน';
    const bodyParts = [`วันที่ ${dayjs(row.date).format('D MMM')}`];
    if (reason) bodyParts.push(`หมายเหตุ: ${reason}`);
    notify(empUserId, {
      type: 'attendance_backdate_rejected',
      title: `ไม่อนุมัติคำขอลงเวลาย้อนหลัง (${typeTxt})`,
      body: bodyParts.join(' · '),
      link: '/attendance',
      relatedId: row.id,
    });
    res.json({ success: true, message: 'ปฏิเสธคำขอแล้ว' });
  } catch (err) {
    console.error('POST /attendance/backdate/:id/reject error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== Admin-record (HR/owner records on employee's behalf) ===== */
// HR or owner manually logs check-in / check-out for any employee on
// any past or current date. Bypasses approval (HR is the authority)
// and writes straight into attendance_logs. The stamp on
// admin_recorded_by + admin_note keeps the audit trail honest.

// POST /api/attendance/admin-record
const adminRecord = async (req, res) => {
  const { employeeId, date, checkInTime, checkOutTime, note } = req.body;
  if (!employeeId || !date) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกพนักงานและวันที่' });
  }
  if (!checkInTime && !checkOutTime) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุเวลาเข้าหรือออกอย่างน้อย 1 อย่าง' });
  }
  // Both sides anchored to TZ. A bare dayjs(date) parses as UTC, so
  // between UTC midnight and 07:00 BKK the picker's "today" would be
  // wrongly classified as the future and rejected.
  if (dayjs.tz(date, TZ).isAfter(nowLocal(), 'day')) {
    return res.status(400).json({ success: false, message: 'ไม่สามารถลงเวลาในวันอนาคตได้' });
  }
  try {
    const emp = await query(
      `SELECT id, first_name, last_name FROM employees WHERE id = $1 AND is_active = true`,
      [employeeId]
    );
    if (!emp.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
    const empRow = emp.rows[0];

    // Build absolute timestamps from the date + TIME components (anchored to TZ).
    const stamp = (t) => t ? dayjs.tz(`${date}T${String(t).slice(0,8)}`, TZ).toISOString() : null;
    const newCheckInAt  = checkInTime  ? stamp(checkInTime)  : null;
    const newCheckOutAt = checkOutTime ? stamp(checkOutTime) : null;

    // Status only recomputed when we're (re)setting the check-in side.
    let newStatus = null, newDetail = null, newAlmostLate = null;
    if (checkInTime) {
      const { config: shiftCfg } = await resolveShiftConfig(empRow.id, date);
      const checkInAsDay = dayjs.tz(`${date}T${String(checkInTime).slice(0,8)}`, TZ);
      const calc = calcStatus(checkInAsDay, shiftCfg);
      newStatus = calc.status; newDetail = calc.detail; newAlmostLate = calc.almostLate;
    }

    // Recompute work_hours when both ends are known. ot_hours stays 0 —
    // see the policy note in checkOut. OT is only earned via /ot/request.
    let workHours = null;
    const otHours = checkOutTime ? 0 : null;
    if (checkOutTime) {
      let checkIn;
      if (checkInTime) checkIn = dayjs.tz(`${date}T${String(checkInTime).slice(0,8)}`, TZ);
      else {
        const existing = await query(
          'SELECT check_in_at FROM attendance_logs WHERE employee_id = $1 AND date = $2',
          [empRow.id, date]
        );
        if (existing.rows[0]?.check_in_at) checkIn = dayjs(existing.rows[0].check_in_at);
      }
      if (checkIn) {
        const checkOut = dayjs.tz(`${date}T${String(checkOutTime).slice(0,8)}`, TZ);
        const minutes = checkOut.diff(checkIn, 'minute');
        if (minutes > 0) {
          workHours = parseFloat((minutes / 60).toFixed(2));
        }
      }
    }

    // Upsert. COALESCE on the existing fields means a check-out-only
    // edit won't clobber the existing check_in_at, and vice versa.
    // missing_checkout gets cleared because the admin actively
    // resolved the row.
    await query(
      `INSERT INTO attendance_logs
         (employee_id, date, check_in_at, check_out_at, status, status_detail, almost_late,
          work_hours, ot_hours, check_in_method, admin_recorded_by, admin_note, missing_checkout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, $11, false)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         check_in_at       = COALESCE($3, attendance_logs.check_in_at),
         check_out_at      = COALESCE($4, attendance_logs.check_out_at),
         status            = COALESCE($5, attendance_logs.status),
         status_detail     = COALESCE($6, attendance_logs.status_detail),
         almost_late       = COALESCE($7, attendance_logs.almost_late),
         work_hours        = COALESCE($8, attendance_logs.work_hours),
         ot_hours          = COALESCE($9, attendance_logs.ot_hours),
         admin_recorded_by = $10,
         admin_note        = COALESCE($11, attendance_logs.admin_note),
         missing_checkout  = false,
         updated_at        = NOW()`,
      [empRow.id, date, newCheckInAt, newCheckOutAt,
       newStatus, newDetail, newAlmostLate, workHours, otHours,
       req.user.id, note ? String(note).trim() : null]
    );

    // Notify the employee — they may have been wondering why their day
    // was empty.
    const empUserId = await userIdFromEmployee(empRow.id);
    const parts = [];
    if (checkInTime)  parts.push(`เข้า ${String(checkInTime).slice(0,5)}`);
    if (checkOutTime) parts.push(`ออก ${String(checkOutTime).slice(0,5)}`);
    notify(empUserId, {
      type: 'attendance_admin_recorded',
      title: 'HR ลงเวลาให้คุณ',
      body: `วันที่ ${dayjs(date).format('D MMM')} · ${parts.join(' / ')}` + (note ? ` · หมายเหตุ: ${String(note).trim().slice(0,60)}` : ''),
      link: '/attendance',
    });

    res.json({ success: true, message: `ลงเวลาให้ ${empRow.first_name} ${empRow.last_name} แล้ว` });
  } catch (err) {
    console.error('POST /attendance/admin-record error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== Missing-checkout sweep (notification-only, no auto-credit) =====
 *
 * An employee who tapped เช็คอิน but never tapped เช็คเอาท์ before the
 * day ended keeps work_hours = 0. We do NOT invent a checkout time or
 * credit half a day — the actual out-time has to come from a backdate
 * request (employee) or admin-record (HR). The sweep's job is to send
 * the *first* nudge and flip missing_checkout=true so the row appears
 * in the past-missing banner on /attendance + /dashboard.
 *
 * Idempotent — already-flagged rows are skipped, so this can run as
 * many times per day as /auth/me is hit without re-spamming the bell.
 * Dayoff + holidays are excluded (you can't "forget" to check out on
 * a day you weren't expected to work).
 */
async function sweepMissingCheckouts() {
  const today = nowLocal().format('YYYY-MM-DD');
  const r = await query(
    `SELECT a.id, a.employee_id, a.date, a.check_in_at,
            e.weekly_shifts,
            CONCAT(e.first_name, ' ', e.last_name) AS emp_name,
            h.id AS holiday_id
       FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
       LEFT JOIN holidays h ON h.date = a.date
      WHERE a.check_in_at IS NOT NULL
        AND a.check_out_at IS NULL
        AND a.date < $1::date
        AND (a.missing_checkout IS NULL OR a.missing_checkout = false)
        AND e.is_active = true`,
    [today]
  );
  let marked = 0;
  for (const row of r.rows) {
    if (row.holiday_id) continue;
    const dowKey = String(dayjs(row.date).day());
    if (row.weekly_shifts && row.weekly_shifts[dowKey] === 'dayoff') continue;

    // Flag-only update — work_hours intentionally untouched.
    await query(
      `UPDATE attendance_logs
          SET missing_checkout = true,
              updated_at       = NOW()
        WHERE id = $1`,
      [row.id]
    );

    // Personal nudge — direct CTA to file the backdate so their hours
    // actually reflect what they worked.
    const empUserId = await userIdFromEmployee(row.employee_id);
    notify(empUserId, {
      type: 'attendance_missing_checkout',
      title: 'คุณลืมเช็คเอาท์',
      body: `${dayjs(row.date).format('D MMM')} · ระบบไม่ได้บันทึกเวลาออก — กรุณายื่นคำขอลงเวลาย้อนหลังเพื่อระบุเวลาออกจริง`,
      link: '/attendance',
      relatedId: row.id,
    });
    marked++;
  }
  return marked;
}

/* ===== Pre-end checkout reminder (Layer 1) =====
 *
 * Live nudge: while an employee is in the [work_end − 15 min, work_end
 * + 30 min] window of their shift and hasn't tapped เช็คเอาท์ yet, send
 * a one-shot reminder (bell + LINE) so they remember before walking out
 * the door. Gated by attendance_logs.checkout_reminder_sent_at so each
 * shift gets at most one ping.
 */
async function sweepCheckoutReminders() {
  const today = nowLocal().format('YYYY-MM-DD');
  // Candidates: checked-in today, not checked-out, not yet pinged.
  const r = await query(
    `SELECT a.id, a.employee_id, a.date,
            e.weekly_shifts, e.shift_type,
            CONCAT(e.first_name, ' ', e.last_name) AS emp_name
       FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
      WHERE a.check_in_at IS NOT NULL
        AND a.check_out_at IS NULL
        AND a.date = $1::date
        AND a.checkout_reminder_sent_at IS NULL
        AND e.is_active = true`,
    [today]
  );
  if (r.rows.length === 0) return 0;

  const nowMin = nowLocal().hour() * 60 + nowLocal().minute();
  let sent = 0;
  for (const row of r.rows) {
    // Resolve the shift to know work_end; skip dayoff / no-config.
    let workEndMin = null;
    try {
      const { config, isDayOff } = await resolveShiftConfig(row.employee_id, row.date);
      if (isDayOff || !config?.work_end) continue;
      workEndMin = timeToMin(config.work_end);
    } catch { continue; }

    // Only ping inside the window. Before the window: too early, they
    // might be on a long lunch. After: the next-day sweep will handle.
    const windowStart = workEndMin - 15;
    const windowEnd   = workEndMin + 30;
    if (nowMin < windowStart || nowMin > windowEnd) continue;

    await query(
      `UPDATE attendance_logs
          SET checkout_reminder_sent_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id]
    );

    const empUserId = await userIdFromEmployee(row.employee_id);
    notify(empUserId, {
      type: 'attendance_checkout_reminder',
      title: 'อย่าลืมเช็คเอาท์ก่อนกลับ',
      body: `ใกล้หมดกะแล้ว — กรุณาเปิดแอปและกดเช็คเอาท์`,
      link: '/attendance',
      relatedId: row.id,
    });
    sent++;
  }
  return sent;
}

/* ===== HR morning digest (Layer 4) =====
 *
 * Once per day on the first /auth/me hit after 08:00 local time, send
 * HR + owner a roll-up of yesterday's unclosed rows so management can
 * chase up offline. The digest counts rows where missing_checkout=true
 * AND date = yesterday — same filter the employee-facing notifications
 * cover, just aggregated into a single summary.
 */
let digestLastRunDay = null;
async function sendMorningDigest() {
  const localNow = nowLocal();
  if (localNow.hour() < 8) return null; // too early
  const todayKey = localNow.format('YYYY-MM-DD');
  if (digestLastRunDay === todayKey) return null; // already sent
  const yesterday = localNow.subtract(1, 'day').format('YYYY-MM-DD');

  const r = await query(
    `SELECT a.id,
            CONCAT(e.first_name, ' ', e.last_name) AS emp_name
       FROM attendance_logs a
       JOIN employees e ON a.employee_id = e.id
      WHERE a.date = $1::date
        AND a.check_in_at IS NOT NULL
        AND a.check_out_at IS NULL
        AND e.is_active = true`,
    [yesterday]
  );
  digestLastRunDay = todayKey;
  if (r.rows.length === 0) return 0;

  // Show up to 5 names inline; the rest is just a count to keep the
  // notification body within bell-friendly length.
  const namesPreview = r.rows.slice(0, 5).map(x => x.emp_name).join(', ');
  const more = r.rows.length > 5 ? ` และอีก ${r.rows.length - 5} คน` : '';
  await notifyManyByRole(['hr', 'owner'], {
    type: 'attendance_missing_checkout_admin',
    title: `เมื่อวานมี ${r.rows.length} คนลืมเช็คเอาท์`,
    body: `${namesPreview}${more} — กดเพื่อดูและบันทึกเวลาแทนได้`,
    link: '/attendance',
  });
  return r.rows.length;
}

// Lazy "cron via traffic" wrapper. Three sweeps run on every /auth/me
// hit but each is gated by its own cadence:
//
//   - sweepMissingCheckouts: once per day (flags yesterday's orphans)
//   - sendMorningDigest:     once per day after 08:00 (HR roll-up)
//   - sweepCheckoutReminders: every 5 minutes (live near-end nudge)
//
// The 5-minute cadence for the reminder is what lets the bell fire
// inside the work_end ±X-minute window even on Render's free tier
// (where there's no real cron). Single in-flight slot covers all three
// to avoid stacking.
let sweepInFlight = null;
let sweepLastRunDay = null;
let reminderLastRunAt = 0;
const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runSweepIfDue() {
  if (sweepInFlight) return sweepInFlight;
  const today = nowLocal().format('YYYY-MM-DD');
  const now = Date.now();
  const needsDaily   = sweepLastRunDay !== today;
  const needsReminder = (now - reminderLastRunAt) >= REMINDER_INTERVAL_MS;
  if (!needsDaily && !needsReminder) return null;

  sweepInFlight = (async () => {
    try {
      let marked = 0;
      if (needsDaily) {
        // Order matters slightly: sweep first so the digest sees the
        // freshly-flagged rows from today's run too.
        marked = await sweepMissingCheckouts();
        await sendMorningDigest();
        sweepLastRunDay = today;
      }
      if (needsReminder) {
        await sweepCheckoutReminders();
        reminderLastRunAt = now;
      }
      return marked;
    } catch (e) {
      console.warn('[sweep-if-due] failed (non-fatal):', e.message);
      return null;
    } finally {
      // Release the in-flight slot 10s later — fast enough that a new
      // reminder cadence isn't blocked, slow enough that a single burst
      // of /auth/me hits dedupes into one run.
      setTimeout(() => { sweepInFlight = null; }, 10_000);
    }
  })();
  return sweepInFlight;
}

// POST /api/attendance/sweep-missing-checkouts — HR/owner manual
// trigger; daily-summary also calls this lazily so the queue stays
// current without requiring a real cron.
const runMissingCheckoutSweep = async (req, res) => {
  try {
    const count = await sweepMissingCheckouts();
    res.json({ success: true, message: `ตรวจสอบแล้ว — พบ ${count} รายการที่ลืมลงเวลาออก`, data: { marked: count } });
  } catch (err) {
    console.error('POST /attendance/sweep-missing-checkouts error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = {
  checkIn, checkOut, getToday, getDailySummary, getMyHistory, getRecentSummary,
  getOffsitePending, approveOffsite, rejectOffsite,
  createBackdateRequest, getBackdatePending, getMyBackdateRequests,
  approveBackdate, rejectBackdate,
  runMissingCheckoutSweep, sweepMissingCheckouts, runSweepIfDue,
  adminRecord,
};
