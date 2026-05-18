// AI Chatbot for employees. Backend is the trust boundary: every tool is
// scoped to the calling user's own employee record (req.user.id ->
// employees.user_id), so the model can't ask for someone else's data even
// if a prompt-injected piece of content told it to.
//
// Model:   claude-haiku-4-5  (cheap + fast, no thinking)
// Pattern: manual tool-use loop (we own the loop so we can sandbox each
//          tool execution + log + rate-limit + cap iterations).
// Cache:   tools + system prompt sit at the prefix, marked with
//          cache_control on the last system block so repeat questions
//          across the same conversation reuse the cached prefix.

const Anthropic = require('@anthropic-ai/sdk').default;
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(tz);

const { query } = require('../../config/database');

const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Bangkok';
const nowLocal = () => dayjs().tz(APP_TZ);

// Lazy init so missing ANTHROPIC_API_KEY at boot doesn't crash the
// whole API — only /api/ai/chat fails with a clear 503.
let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const MAX_TOOL_ITERATIONS = 6;          // hard cap on tool-loop turns
const MAX_OUTPUT_TOKENS   = 1024;
const MAX_USER_MESSAGE_CHARS = 4000;    // truncate absurdly long inputs
const MAX_HISTORY_MESSAGES   = 20;      // last N messages kept (excl. system)
const DAILY_MESSAGE_QUOTA    = 30;      // per user, resets at Bangkok midnight

// =====================================================================
// SYSTEM PROMPT
// =====================================================================
// Stays static so prompt caching can hit. Anything per-request (user
// name, role, today's date) is injected by appending a small second
// system block AFTER the cache breakpoint — that block is read on every
// turn but the big static instructions above it stay cached.
const SYSTEM_STATIC = `คุณคือผู้ช่วย HR ของระบบ "สิริคอนส์ HR" ตอบเป็นภาษาไทยที่สุภาพ กระชับ และตรงประเด็น

ขอบเขตหน้าที่:
- ช่วยพนักงานตอบคำถามเกี่ยวกับ การลา/โควต้าวันลา, การลงเวลา, สลิปเงินเดือน, OT, กะการทำงาน, วันหยุดบริษัท, และกิจกรรม/ประกาศที่พนักงานคนนั้นมีสิทธิ์เห็น
- ใช้ tools ที่มีให้เพื่อดึงข้อมูลจริงเสมอ ห้ามเดา ห้ามสมมุติตัวเลข
- ข้อมูลทั้งหมดที่ดึงผ่าน tools เป็น "ข้อมูลของผู้ใช้คนนี้เท่านั้น" ไม่ใช่ของคนอื่น
- ถ้า user ถามข้อมูลของพนักงานคนอื่น ให้ตอบสุภาพว่าระบบนี้ดูได้แค่ข้อมูลของผู้ใช้เอง แนะนำให้ติดต่อ HR

วิธีตอบ:
- ตอบสั้น ตรงประเด็น ใช้ bullet/ตาราง markdown ได้ถ้าช่วยอ่านง่ายขึ้น
- ตัวเลขเงินใส่หน่วย "บาท" และคั่นหลักพันด้วย comma
- วันที่ใช้รูปแบบ "5 พ.ค. 2569" (พุทธศักราช) เว้นแต่ user ขอแบบอื่น
- ถ้า tool ไม่มีข้อมูล ให้บอกตามตรงว่ายังไม่มีข้อมูล อย่าแต่งขึ้นมา
- ถ้าคำถามคลุมเครือ ถามกลับสั้น ๆ เพื่อยืนยัน
- ห้ามให้คำแนะนำทางการแพทย์ การลงทุน หรือกฎหมาย ในกรณีเหล่านั้นแนะนำให้ปรึกษาผู้เชี่ยวชาญ
- ห้ามทำ action ที่เปลี่ยนข้อมูล (เช่น สร้างใบลา, อนุมัติ, แก้สลิป) — tools เป็นแบบอ่านอย่างเดียวเท่านั้น

ถ้าคำถามไม่เกี่ยวกับ HR เลย เช่น เขียนโปรแกรม, แปลภาษา, คำนวณทั่วไป — ให้ตอบสุภาพว่าระบบนี้ออกแบบไว้สำหรับช่วย HR เป็นหลัก แต่ยินดีตอบให้ในขอบเขตที่เหมาะสม`;

// =====================================================================
// TOOL CATALOG
// =====================================================================
const TOOLS = [
  {
    name: 'get_my_leave_quota',
    description: 'ดึงโควต้าวันลาของพนักงานคนปัจจุบันในปีที่ระบุ (รวมประเภทลา/วันที่ใช้ไป/คงเหลือ)',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'ปี ค.ศ. เช่น 2026 (default = ปีปัจจุบัน)' },
      },
    },
  },
  {
    name: 'get_my_leave_history',
    description: 'ดึงประวัติคำขอลาของพนักงานคนปัจจุบัน',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'กรองปี ค.ศ. (default = ปีปัจจุบัน)' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        limit: { type: 'integer', description: 'จำนวนรายการสูงสุด (1-30, default 10)' },
      },
    },
  },
  {
    name: 'get_my_attendance_today',
    description: 'ดึงสถานะลงเวลาของพนักงานคนปัจจุบันสำหรับวันนี้ + กะที่ต้องเข้า',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_attendance_recent',
    description: 'ดึงประวัติลงเวลาของพนักงานคนปัจจุบัน N วันล่าสุด',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'จำนวนวันย้อนหลัง (1-60, default 14)' },
      },
    },
  },
  {
    name: 'get_my_ot_history',
    description: 'ดึงคำขอ OT ของพนักงานคนปัจจุบัน',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        limit: { type: 'integer', description: '1-30, default 10' },
      },
    },
  },
  {
    name: 'get_my_payroll',
    description: 'ดึงสลิปเงินเดือนของพนักงานคนปัจจุบัน สำหรับเดือน/ปี ที่ระบุ (หรือ "ล่าสุด")',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'integer', description: '1-12' },
        year:  { type: 'integer' },
        latest: { type: 'boolean', description: 'true = ดึงสลิปล่าสุด (ข้าม month/year)' },
      },
    },
  },
  {
    name: 'get_my_shift_week',
    description: 'ดึงตารางกะทำงานของพนักงานคนปัจจุบันใน 7 วันข้างหน้า',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_company_holidays',
    description: 'ดึงรายการวันหยุดบริษัท',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'default = ปีปัจจุบัน' },
        upcoming_only: { type: 'boolean', description: 'true = เฉพาะที่ยังไม่ถึง' },
      },
    },
  },
  {
    name: 'get_upcoming_events',
    description: 'ดึงกิจกรรม/ประชุม/ประกาศจากปฏิทินที่พนักงานคนปัจจุบันมีสิทธิ์เห็น',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'จำนวนวันข้างหน้า (1-90, default 30)' },
      },
    },
  },
  {
    name: 'get_company_info',
    description: 'ดึงข้อมูลทั่วไปของบริษัท (ชื่อ ที่อยู่ เบอร์ติดต่อ อีเมล)',
    input_schema: { type: 'object', properties: {} },
  },
];

// =====================================================================
// TOOL IMPLEMENTATIONS
//   ctx = { userId, employeeId, role, departmentId }
// Each tool MUST scope queries to ctx.* — never trust input for identity.
// =====================================================================

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const toolHandlers = {
  async get_my_leave_quota(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const year = clampInt(input.year, 2000, 2100, nowLocal().year());
    // Lazy seed if missing — same pattern as leaveController.getMyQuota.
    await query(
      `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
       SELECT $1, lt.id, $2, COALESCE(lt.days_per_year, 0), 0
         FROM leave_types lt WHERE lt.is_active = true
       ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
      [ctx.employeeId, year]
    );
    const r = await query(
      `SELECT lt.name AS leave_type,
              lq.total_days,
              lq.used_days,
              (COALESCE(lq.total_days,0) - COALESCE(lq.used_days,0)) AS remaining_days
         FROM leave_quotas lq
         JOIN leave_types lt ON lq.leave_type_id = lt.id
        WHERE lq.employee_id = $1 AND lq.year = $2
        ORDER BY lt.name`,
      [ctx.employeeId, year]
    );
    return { year, quotas: r.rows };
  },

  async get_my_leave_history(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const limit = clampInt(input.limit, 1, 30, 10);
    const conds = ['lr.employee_id = $1'];
    const params = [ctx.employeeId];
    if (Number.isInteger(input.year)) {
      conds.push(`EXTRACT(YEAR FROM lr.start_date) = $${params.length + 1}`);
      params.push(input.year);
    }
    if (input.status && ['pending','approved','rejected'].includes(input.status)) {
      conds.push(`lr.status = $${params.length + 1}`);
      params.push(input.status);
    }
    const r = await query(
      `SELECT lt.name AS leave_type,
              lr.start_date, lr.end_date, lr.days_count,
              lr.status, lr.reason, lr.hr_notes, lr.created_at
         FROM leave_requests lr
         JOIN leave_types lt ON lr.leave_type_id = lt.id
        WHERE ${conds.join(' AND ')}
        ORDER BY lr.start_date DESC
        LIMIT ${limit}`,
      params
    );
    return { requests: r.rows };
  },

  async get_my_attendance_today(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const today = nowLocal().format('YYYY-MM-DD');
    const [logR, shiftR, holR] = await Promise.all([
      query(
        `SELECT date, check_in_time, check_out_time, status, status_detail,
                work_hours, almost_late, is_offsite, offsite_status, missing_checkout
           FROM attendance_logs
          WHERE employee_id = $1 AND date = $2`,
        [ctx.employeeId, today]
      ),
      query(
        `SELECT e.shift_type, e.weekly_shifts
           FROM employees e WHERE e.id = $1`,
        [ctx.employeeId]
      ),
      query(`SELECT name, type FROM holidays WHERE date = $1`, [today]),
    ]);
    const emp = shiftR.rows[0] || {};
    const dowKey = String(dayjs(today).day());
    const weekly = emp.weekly_shifts || {};
    const codeForToday = weekly[dowKey];
    let shiftInfo = null;
    if (codeForToday && codeForToday !== 'dayoff') {
      const cfg = await query(
        `SELECT code, name, work_start, work_end, checkin_start, checkin_end
           FROM shift_configs WHERE code = $1`,
        [codeForToday]
      );
      shiftInfo = cfg.rows[0] || { code: codeForToday };
    }
    return {
      date: today,
      is_dayoff: codeForToday === 'dayoff',
      is_holiday: !!holR.rows[0],
      holiday: holR.rows[0] || null,
      shift: shiftInfo,
      attendance: logR.rows[0] || null,
    };
  },

  async get_my_attendance_recent(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const days = clampInt(input.days, 1, 60, 14);
    const since = nowLocal().subtract(days - 1, 'day').format('YYYY-MM-DD');
    const r = await query(
      `SELECT date, check_in_time, check_out_time, status, status_detail,
              work_hours, almost_late, is_offsite, offsite_status, missing_checkout
         FROM attendance_logs
        WHERE employee_id = $1 AND date >= $2
        ORDER BY date DESC`,
      [ctx.employeeId, since]
    );
    // Quick aggregate so the model doesn't have to count rows itself.
    const summary = { present: 0, late: 0, absent: 0, leave: 0, offsite_pending: 0 };
    for (const row of r.rows) {
      if (row.is_offsite && row.offsite_status === 'pending') summary.offsite_pending++;
      if (row.status === 'present') summary.present++;
      else if (row.status === 'late') summary.late++;
      else if (row.status === 'absent') summary.absent++;
      else if (row.status === 'leave') summary.leave++;
    }
    return { days, since, summary, records: r.rows };
  },

  async get_my_ot_history(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const limit = clampInt(input.limit, 1, 30, 10);
    const conds = ['employee_id = $1'];
    const params = [ctx.employeeId];
    if (Number.isInteger(input.year)) {
      conds.push(`EXTRACT(YEAR FROM date) = $${params.length + 1}`);
      params.push(input.year);
    }
    // Status enum in DB: pending | manager_approved | hr_approved | rejected.
    // We expose the simpler tri-state to the model and translate here:
    //   "approved" -> hr_approved (fully approved)
    //   "pending"  -> pending OR manager_approved (still in flight)
    //   "rejected" -> rejected
    if (input.status === 'approved') {
      conds.push(`status = 'hr_approved'`);
    } else if (input.status === 'pending') {
      conds.push(`status IN ('pending','manager_approved')`);
    } else if (input.status === 'rejected') {
      conds.push(`status = 'rejected'`);
    }
    // Schema lookup is forgiving — if ot_requests doesn't exist yet on a
    // legacy DB, just say so cleanly instead of 500ing into the model.
    try {
      const r = await query(
        `SELECT date, start_time, end_time, hours, reason, status, rejected_reason, created_at
           FROM ot_requests
          WHERE ${conds.join(' AND ')}
          ORDER BY date DESC
          LIMIT ${limit}`,
        params
      );
      const totalApprovedHours = r.rows
        .filter(x => x.status === 'hr_approved')
        .reduce((sum, x) => sum + Number(x.hours || 0), 0);
      return { requests: r.rows, totalApprovedHours };
    } catch (err) {
      return { error: 'OT data unavailable: ' + (err.message || 'unknown') };
    }
  },

  async get_my_payroll(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    if (input.latest) {
      const r = await query(
        `SELECT month, year, base_salary, ot_amount, bonus, allowances,
                social_security, income_tax, other_deductions, net_salary,
                work_days, absent_days, late_count, ot_hours, status, paid_at
           FROM payroll_records
          WHERE employee_id = $1
            AND status IN ('approved','paid')
          ORDER BY year DESC, month DESC
          LIMIT 1`,
        [ctx.employeeId]
      );
      return { slip: r.rows[0] || null };
    }
    const month = clampInt(input.month, 1, 12, nowLocal().month() + 1);
    const year  = clampInt(input.year, 2000, 2100, nowLocal().year());
    const r = await query(
      `SELECT month, year, base_salary, ot_amount, bonus, allowances,
              social_security, income_tax, other_deductions, net_salary,
              work_days, absent_days, late_count, ot_hours, status, paid_at
         FROM payroll_records
        WHERE employee_id = $1 AND month = $2 AND year = $3
          AND status IN ('approved','paid')`,
      [ctx.employeeId, month, year]
    );
    return { month, year, slip: r.rows[0] || null };
  },

  async get_my_shift_week(input, ctx) {
    if (!ctx.employeeId) return { error: 'no employee record linked to this account' };
    const empR = await query(`SELECT weekly_shifts FROM employees WHERE id = $1`, [ctx.employeeId]);
    const weekly = empR.rows[0]?.weekly_shifts || {};
    const codes = new Set(
      Object.values(weekly).filter(v => v && v !== 'dayoff')
    );
    const cfgMap = {};
    if (codes.size > 0) {
      const cfgs = await query(
        `SELECT code, name, work_start, work_end, checkin_start, checkin_end
           FROM shift_configs WHERE code = ANY($1::text[])`,
        [Array.from(codes)]
      );
      for (const c of cfgs.rows) cfgMap[c.code] = c;
    }
    const today = nowLocal();
    const upcoming = [];
    for (let i = 0; i < 7; i++) {
      const d = today.add(i, 'day');
      const dow = d.day();
      const code = weekly[String(dow)];
      const isDayoff = !code || code === 'dayoff';
      upcoming.push({
        date: d.format('YYYY-MM-DD'),
        weekday: ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'][dow],
        is_dayoff: isDayoff,
        shift: isDayoff ? null : (cfgMap[code] || { code }),
      });
    }
    return { week: upcoming };
  },

  async get_company_holidays(input, ctx) {
    const year = clampInt(input.year, 2000, 2100, nowLocal().year());
    const upcomingOnly = !!input.upcoming_only;
    const conds = ['year = $1'];
    const params = [year];
    if (upcomingOnly) {
      conds.push(`date >= $${params.length + 1}::date`);
      params.push(nowLocal().format('YYYY-MM-DD'));
    }
    const r = await query(
      `SELECT name, date, type FROM holidays
        WHERE ${conds.join(' AND ')}
        ORDER BY date`,
      params
    );
    return { year, upcoming_only: upcomingOnly, holidays: r.rows };
  },

  async get_upcoming_events(input, ctx) {
    const days = clampInt(input.days, 1, 90, 30);
    const today = nowLocal().format('YYYY-MM-DD');
    const until = nowLocal().add(days, 'day').format('YYYY-MM-DD');
    // Visibility: all | department (mine) | specific (I'm in attendee_ids).
    // Owners + HR see everything.
    const isPriv = ctx.role === 'owner' || ctx.role === 'hr';
    try {
      const r = await query(
        `SELECT id, title, description, event_type, start_date, end_date,
                start_time, end_time, location, color, visibility
           FROM calendar_events ce
          WHERE ce.start_date BETWEEN $1::date AND $2::date
            AND (
              $3 = true
              OR ce.visibility = 'all'
              OR (ce.visibility = 'department' AND ce.department_id = $4)
              OR (ce.visibility = 'specific'   AND $5::uuid = ANY(ce.attendee_ids))
            )
          ORDER BY start_date, start_time NULLS FIRST
          LIMIT 30`,
        [today, until, isPriv, ctx.departmentId || null, ctx.employeeId || null]
      );
      return { days, since: today, until, events: r.rows };
    } catch (err) {
      return { error: 'events unavailable: ' + (err.message || 'unknown') };
    }
  },

  async get_company_info(input, ctx) {
    const r = await query(
      `SELECT company_name, company_name_en, company_address,
              company_phone, company_email
         FROM org_settings WHERE id = 1`
    );
    return { company: r.rows[0] || null };
  },
};

// =====================================================================
// RATE LIMIT — per-user per-day, Bangkok-anchored
// =====================================================================
// In-process Map. Survives until next restart. The cap is generous
// enough that a busy day at one user is ~30 calls, so a restart-resets
// failure mode is fine in practice.
const usageMap = new Map(); // userId -> { dayKey, count }
function bumpUsage(userId) {
  const dayKey = nowLocal().format('YYYY-MM-DD');
  const cur = usageMap.get(userId);
  if (!cur || cur.dayKey !== dayKey) {
    usageMap.set(userId, { dayKey, count: 1 });
    return { count: 1, dayKey };
  }
  cur.count += 1;
  return { ...cur };
}
function getUsage(userId) {
  const dayKey = nowLocal().format('YYYY-MM-DD');
  const cur = usageMap.get(userId);
  if (!cur || cur.dayKey !== dayKey) return { count: 0, dayKey };
  return { ...cur };
}

// =====================================================================
// MAIN HANDLER  —  POST /api/ai/chat
//   body: { messages: [{ role: 'user'|'assistant', content: string }] }
// Returns:    { success: true, data: { reply, usage, model } }
// =====================================================================
const chat = async (req, res) => {
  try {
    const client = getClient();
    if (!client) {
      return res.status(503).json({
        success: false,
        message: 'ผู้ดูแลระบบยังไม่ได้ตั้งค่า AI (ANTHROPIC_API_KEY)',
      });
    }

    // Build employee context from req.user (set by authenticate middleware).
    const empRow = await query(
      `SELECT e.id, e.first_name, e.last_name, e.nickname, e.position,
              e.department_id, d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.user_id = $1`,
      [req.user.id]
    );
    const emp = empRow.rows[0] || null;
    const ctx = {
      userId: req.user.id,
      role: req.user.role,
      employeeId: emp?.id || null,
      departmentId: emp?.department_id || null,
    };

    // Rate limit
    const usageBefore = getUsage(ctx.userId);
    if (usageBefore.count >= DAILY_MESSAGE_QUOTA) {
      return res.status(429).json({
        success: false,
        message: `วันนี้คุณใช้ AI ครบโควต้า ${DAILY_MESSAGE_QUOTA} ข้อความแล้ว ลองใหม่พรุ่งนี้`,
        usage: usageBefore,
      });
    }

    // Validate + sanitize messages.
    const inbound = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!inbound || inbound.length === 0) {
      return res.status(400).json({ success: false, message: 'messages ว่างเปล่า' });
    }
    const messages = [];
    for (const m of inbound.slice(-MAX_HISTORY_MESSAGES)) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
        const content = m.content.slice(0, MAX_USER_MESSAGE_CHARS);
        if (content.trim()) messages.push({ role: m.role, content });
      }
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ success: false, message: 'ข้อความล่าสุดต้องเป็นของผู้ใช้' });
    }

    // Per-request system block (NOT cached — small).
    const todayStr = nowLocal().format('YYYY-MM-DD');
    const displayName = emp ? (emp.nickname || emp.first_name || '') : '';
    const dynamicSystem =
      `ผู้ใช้ปัจจุบัน: ${displayName || '(ไม่ระบุชื่อ)'}` +
      (emp?.position ? ` | ตำแหน่ง: ${emp.position}` : '') +
      (emp?.department_name ? ` | แผนก: ${emp.department_name}` : '') +
      ` | role: ${ctx.role}` +
      ` | วันนี้: ${todayStr}`;

    // Cached prefix = static system block (with cache_control) + tools.
    // Per-request prefix = dynamic system block (no cache_control).
    const systemBlocks = [
      { type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicSystem },
    ];

    // Manual tool-use loop.
    const convo = [...messages];
    let lastReply = '';
    let iterations = 0;
    let stop_reason = null;
    let usageTotals = { input_tokens: 0, output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0 };

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemBlocks,
        tools: TOOLS,
        messages: convo,
      });

      // Accumulate usage
      if (resp.usage) {
        usageTotals.input_tokens          += resp.usage.input_tokens || 0;
        usageTotals.output_tokens         += resp.usage.output_tokens || 0;
        usageTotals.cache_creation_input_tokens += resp.usage.cache_creation_input_tokens || 0;
        usageTotals.cache_read_input_tokens     += resp.usage.cache_read_input_tokens || 0;
      }
      stop_reason = resp.stop_reason;

      // Append assistant turn verbatim (including tool_use blocks) so the
      // model can resolve its own tool_use_id on the next turn.
      convo.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason !== 'tool_use') {
        // Extract final text reply.
        lastReply = resp.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim();
        break;
      }

      // Run every tool_use block this turn, in parallel-ish (sequential
      // is fine — tool calls are small and our DB is the bottleneck).
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = toolHandlers[block.name];
        let result;
        if (!handler) {
          result = { error: `unknown tool: ${block.name}` };
        } else {
          try {
            result = await handler(block.input || {}, ctx);
          } catch (err) {
            console.error(`[ai] tool ${block.name} failed:`, err.message);
            result = { error: 'tool execution failed' };
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      convo.push({ role: 'user', content: toolResults });
      // Loop continues — next messages.create call sees the tool_results.
    }

    if (!lastReply && stop_reason === 'tool_use') {
      lastReply = 'ขออภัย ระบบใช้เครื่องมือเกินจำนวนรอบที่อนุญาต กรุณาถามใหม่ในรูปแบบที่กระชับขึ้น';
    } else if (!lastReply) {
      lastReply = 'ขออภัย ไม่สามารถสร้างคำตอบได้ในตอนนี้';
    }

    const usageAfter = bumpUsage(ctx.userId);

    return res.json({
      success: true,
      data: {
        reply: lastReply,
        model: MODEL,
        iterations,
        stop_reason,
        usage: {
          message_count_today: usageAfter.count,
          daily_quota: DAILY_MESSAGE_QUOTA,
          tokens: usageTotals,
        },
      },
    });
  } catch (err) {
    // Anthropic SDK throws typed errors with `.status` for HTTP issues.
    const status = err?.status || 500;
    console.error('[ai] /chat error:', err?.message || err);
    if (status === 401) {
      return res.status(503).json({ success: false, message: 'ANTHROPIC_API_KEY ไม่ถูกต้อง' });
    }
    if (status === 429) {
      return res.status(429).json({ success: false, message: 'AI กำลังคิวยาว กรุณาลองใหม่ในอีกครู่' });
    }
    if (status === 529 || status === 503) {
      return res.status(503).json({ success: false, message: 'AI ขัดข้องชั่วคราว กรุณาลองใหม่' });
    }
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเรียก AI' });
  }
};

// GET /api/ai/status — frontend uses this to decide whether to render
// the chat widget at all. Returns { enabled, dailyQuota, used }.
const status = async (req, res) => {
  const enabled = !!process.env.ANTHROPIC_API_KEY;
  const used = req.user?.id ? getUsage(req.user.id).count : 0;
  return res.json({
    success: true,
    data: {
      enabled,
      model: MODEL,
      daily_quota: DAILY_MESSAGE_QUOTA,
      used_today: used,
    },
  });
};

module.exports = { chat, status };
