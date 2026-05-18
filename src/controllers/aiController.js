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

const { query, pool } = require('../../config/database');
const { notify, userIdFromEmployee } = require('../middleware/notify');

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
const MAX_TOOL_ITERATIONS = 10;         // hard cap on tool-loop turns
                                        // (bumped from 6 to handle admin
                                        // flows: lookup → preview → confirm
                                        // → execute → notify can be 3-5
                                        // tool calls in one user turn)
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
- ช่วยตอบคำถามเกี่ยวกับ การลา/โควต้าวันลา, การลงเวลา, สลิปเงินเดือน, OT, กะการทำงาน, วันหยุดบริษัท, และกิจกรรม/ประกาศที่ผู้ใช้คนนั้นมีสิทธิ์เห็น
- ใช้ tools ที่มีให้เพื่อดึงข้อมูลจริงเสมอ ห้ามเดา ห้ามสมมุติตัวเลข
- read tool ที่ขึ้นต้นด้วย get_my_* ดึง "ข้อมูลของผู้ใช้คนปัจจุบันเอง" ไม่ใช่ของคนอื่น
- ถ้าผู้ใช้เป็นพนักงาน (role=employee) และถามข้อมูลของคนอื่น ให้ตอบสุภาพว่าดูได้เฉพาะของตัวเอง

สิทธิ์ในการแก้ไขข้อมูล:
- เจ้าของ (owner) และ HR — มี write tool สำหรับ: เพิ่ม/ลบวันหยุด, สร้างประกาศ, สร้างกิจกรรมปฏิทิน, อนุมัติ/ปฏิเสธคำขอลา-OT, ปรับกะรายวัน, ปรับโควต้าลา
- พนักงานทั่วไป — read-only ห้ามเรียก write tool เด็ดขาด (จะถูก backend ปฏิเสธอยู่แล้ว)

⚠️ กฎ "ยืนยันก่อนเขียน" — สำคัญมาก:
ทุก write tool ต้องเรียก 2 ครั้ง:
1. ครั้งแรกใส่ confirmed=false → tool จะคืน preview สรุปสิ่งที่จะเปลี่ยน
2. แสดง preview ให้ user เห็นเป็นข้อความสั้น ๆ พร้อมถาม "ยืนยันใช่ไหมครับ?"
3. รอ user ตอบคำว่า "ยืนยัน" / "ตกลง" / "OK" / "ใช่" / "ทำเลย" หรือคำที่สื่อความหมายชัดเจน
4. เรียก tool ครั้งที่ 2 ด้วย parameters เดิม + confirmed=true → จะทำการเขียนข้อมูลจริง
5. ตอบ user ว่าสำเร็จ + สรุปสิ่งที่ทำ

ห้ามเรียกด้วย confirmed=true ในรอบเดียวกันกับที่ user สั่ง — ต้องรอ user reply ยืนยันก่อนเสมอ
ถ้า user บอกยกเลิก / ไม่ทำ ก็หยุดและตอบรับ ไม่ต้องเรียก tool อะไรเพิ่ม

วิธีหา id เมื่อ user พูดเป็นชื่อ:
- ใช้ find_employee เพื่อหา employee_id จากชื่อ/เล่น/รหัส
- ใช้ find_pending_leaves / find_pending_ot เพื่อหา request_id ของคำขอที่รออนุมัติ
- ถ้าพบหลายคนหรือหลายคำขอที่ตรงกัน ให้ user เลือกก่อน อย่าเดา

วิธีตอบ:
- ตอบสั้น ตรงประเด็น ใช้ bullet/ตาราง markdown ได้ถ้าช่วยอ่านง่ายขึ้น
- ตัวเลขเงินใส่หน่วย "บาท" และคั่นหลักพันด้วย comma
- วันที่ใช้รูปแบบ "5 พ.ค. 2569" (พุทธศักราช) เว้นแต่ user ขอแบบอื่น
- ถ้า tool ไม่มีข้อมูล ให้บอกตามตรงว่ายังไม่มีข้อมูล อย่าแต่งขึ้นมา
- ถ้าคำถามคลุมเครือ ถามกลับสั้น ๆ เพื่อยืนยัน
- ห้ามให้คำแนะนำทางการแพทย์ การลงทุน หรือกฎหมาย ในกรณีเหล่านั้นแนะนำให้ปรึกษาผู้เชี่ยวชาญ

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
// ADMIN TOOLS — owner / hr only.
// Read-only lookups are listed first; every tool whose name starts with
// add_/delete_/create_/approve_/reject_/set_ requires the 2-step
// confirmed:false → confirmed:true pattern. Without confirmed:true, the
// tool returns a preview only — the DB is NOT touched.
// =====================================================================
const ADMIN_TOOLS = [
  // ----- read helpers -----
  {
    name: 'find_employee',
    description: 'ค้นหาพนักงานจากชื่อ ชื่อเล่น หรือรหัส (ใช้เมื่อ user พูดถึงคนแต่ไม่ทราบ employee_id). คืน list สูงสุด 10 คน — ถ้าได้หลายคน ให้ user เลือกก่อน',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'คำค้น (ชื่อจริง/นามสกุล/เล่น/รหัสพนักงาน) อย่างน้อย 2 ตัวอักษร' },
      },
      required: ['q'],
    },
  },
  {
    name: 'find_pending_leaves',
    description: 'รายการคำขอลาทั้งหมดที่ยังรออนุมัติ (สำหรับ owner/hr)',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '1-30, default 10' },
      },
    },
  },
  {
    name: 'find_pending_ot',
    description: 'รายการคำขอ OT ที่ยังรออนุมัติ (สำหรับ owner/hr)',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '1-30, default 10' },
      },
    },
  },

  // ----- write: holidays -----
  {
    name: 'add_holiday',
    description: 'เพิ่มวันหยุดของบริษัท. ต้องเรียก 2 ครั้ง: confirmed=false เพื่อดู preview, แล้วรอ user ยืนยัน, ก่อน confirmed=true',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        name: { type: 'string', description: 'ชื่อวันหยุด เช่น วันแม่แห่งชาติ' },
        type: { type: 'string', enum: ['national', 'company', 'compensatory'], description: 'default national' },
        confirmed: { type: 'boolean', description: 'true เฉพาะเมื่อ user ยืนยันแล้วในรอบแชทก่อนหน้า' },
      },
      required: ['date', 'name'],
    },
  },
  {
    name: 'delete_holiday',
    description: 'ลบวันหยุดของบริษัทตามวันที่. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        confirmed: { type: 'boolean' },
      },
      required: ['date'],
    },
  },

  // ----- write: announcements -----
  {
    name: 'create_announcement',
    description: 'สร้างประกาศใหม่ให้พนักงานทุกคนเห็น. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', enum: ['info', 'important', 'holiday', 'urgent'], description: 'default info' },
        confirmed: { type: 'boolean' },
      },
      required: ['title', 'content'],
    },
  },

  // ----- write: events -----
  {
    name: 'create_event',
    description: 'สร้างกิจกรรม/ประชุมในปฏิทินบริษัท. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD (omit = single day)' },
        start_time: { type: 'string', description: 'HH:MM (omit = all-day)' },
        end_time: { type: 'string', description: 'HH:MM' },
        location: { type: 'string' },
        description: { type: 'string' },
        visibility: { type: 'string', enum: ['all', 'department', 'specific'], description: 'default all' },
        confirmed: { type: 'boolean' },
      },
      required: ['title', 'start_date'],
    },
  },

  // ----- write: leave approve/reject -----
  {
    name: 'approve_leave_request',
    description: 'อนุมัติคำขอลา (หัก quota + เขียน attendance_logs ให้อัตโนมัติ). 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'UUID จาก find_pending_leaves' },
        hr_notes: { type: 'string', description: 'หมายเหตุเพิ่มเติม (optional)' },
        confirmed: { type: 'boolean' },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'reject_leave_request',
    description: 'ปฏิเสธคำขอลา. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        reason: { type: 'string', description: 'เหตุผลที่ปฏิเสธ' },
        confirmed: { type: 'boolean' },
      },
      required: ['request_id', 'reason'],
    },
  },

  // ----- write: OT approve/reject -----
  {
    name: 'approve_ot_request',
    description: 'อนุมัติคำขอ OT (จะถูก mark เป็น hr_approved). 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'reject_ot_request',
    description: 'ปฏิเสธคำขอ OT. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['request_id', 'reason'],
    },
  },

  // ----- write: shift override -----
  {
    name: 'set_employee_shift_day',
    description: 'กำหนดกะของพนักงานในวันใดวันหนึ่ง (override กะประจำ) เช่นเปลี่ยนเป็น dayoff หรือเปลี่ยนเป็น code อื่น. 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        employee_id: { type: 'string', description: 'UUID จาก find_employee' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        shift_code: { type: 'string', description: 'รหัส shift_configs.code เช่น WC001 หรือคำว่า dayoff' },
        confirmed: { type: 'boolean' },
      },
      required: ['employee_id', 'date', 'shift_code'],
    },
  },

  // ----- write: quota override -----
  {
    name: 'set_employee_quota',
    description: 'ตั้งโควต้าวันลาของพนักงานคนหนึ่ง (เช่น ให้พักร้อน 12 วัน). 2-step ยืนยัน',
    input_schema: {
      type: 'object',
      properties: {
        employee_id: { type: 'string' },
        leave_type_name: { type: 'string', description: 'ชื่อประเภทลา เช่น "ลาพักร้อน" — จะถูก match กับ leave_types.name' },
        year: { type: 'integer', description: 'default ปีปัจจุบัน' },
        total_days: { type: 'number', description: 'จำนวนวันทั้งหมด (>= 0)' },
        confirmed: { type: 'boolean' },
      },
      required: ['employee_id', 'leave_type_name', 'total_days'],
    },
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
// ADMIN TOOL HANDLERS — owner/hr only.
// Every write handler honors the 2-step pattern: if input.confirmed is
// not literally true, return a preview and DO NOT touch the DB. Once
// confirmed=true is passed, perform the write inside a transaction and
// stamp an audit_logs row attributing the change to the calling user
// (so a chat-driven write is traceable just like a UI-driven one).
// =====================================================================

// Guard helper. Returns null when allowed, or an error payload otherwise.
function requireAdmin(ctx) {
  if (ctx.role !== 'owner' && ctx.role !== 'hr') {
    return { error: 'permission denied: tool requires owner or HR role' };
  }
  return null;
}

// Stamp the audit row out-of-band. Same shape the express middleware
// would write so /audit-logs surfaces these AI-driven actions next to
// UI actions. Fire-and-forget — we don't want a flaky audit insert to
// fail the user's chat.
function auditFromAI(userId, action, resource, resourceId, details) {
  query(
    `INSERT INTO audit_logs (user_id, action, resource, resource_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      userId || null,
      action,
      resource,
      resourceId || null,
      JSON.stringify({ via: 'ai_chat', ...(details || {}) }),
    ]
  ).catch(err => console.error('[ai-audit] failed:', err.message));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const adminHandlers = {
  // -------- read helpers --------
  async find_employee(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    const q = (input.q || '').trim();
    if (q.length < 2) return { error: 'q ต้องมีอย่างน้อย 2 ตัวอักษร' };
    const like = `%${q}%`;
    const r = await query(
      `SELECT e.id, e.first_name, e.last_name, e.nickname,
              e.employee_id AS emp_code, e.position,
              d.name AS department_name, u.role AS user_role
         FROM employees e
         LEFT JOIN users u ON e.user_id = u.id
         LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.is_active = true
          AND (
            e.first_name ILIKE $1
            OR e.last_name ILIKE $1
            OR e.nickname ILIKE $1
            OR e.employee_id ILIKE $1
            OR (e.first_name || ' ' || e.last_name) ILIKE $1
          )
        ORDER BY e.first_name, e.last_name
        LIMIT 10`,
      [like]
    );
    return { matches: r.rows };
  },

  async find_pending_leaves(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    const limit = clampInt(input.limit, 1, 30, 10);
    const r = await query(
      `SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.days_count,
              lr.reason, lr.created_at,
              lt.name AS leave_type,
              e.first_name, e.last_name, e.nickname
         FROM leave_requests lr
         JOIN leave_types lt ON lr.leave_type_id = lt.id
         JOIN employees e ON lr.employee_id = e.id
        WHERE lr.status = 'pending'
        ORDER BY lr.created_at ASC
        LIMIT ${limit}`
    );
    return { pending: r.rows };
  },

  async find_pending_ot(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    const limit = clampInt(input.limit, 1, 30, 10);
    const r = await query(
      `SELECT o.id, o.employee_id, o.date, o.start_time, o.end_time, o.hours,
              o.reason, o.status, o.created_at,
              e.first_name, e.last_name, e.nickname
         FROM ot_requests o
         JOIN employees e ON o.employee_id = e.id
        WHERE o.status IN ('pending', 'manager_approved')
        ORDER BY o.created_at ASC
        LIMIT ${limit}`
    );
    return { pending: r.rows };
  },

  // -------- write: holidays --------
  async add_holiday(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!DATE_RE.test(String(input.date || ''))) return { error: 'date ต้องเป็น YYYY-MM-DD' };
    const name = String(input.name || '').trim();
    if (!name) return { error: 'name ว่างไม่ได้' };
    const type = ['national', 'company', 'compensatory'].includes(input.type) ? input.type : 'national';

    // Always return preview first when not confirmed.
    if (input.confirmed !== true) {
      // Check for collisions so the preview can warn about an existing row.
      const dup = await query(`SELECT name FROM holidays WHERE date = $1`, [input.date]);
      return {
        preview: true,
        action: 'add_holiday',
        date: input.date,
        name,
        type,
        already_exists: dup.rows.length > 0,
        existing_name: dup.rows[0]?.name || null,
        instructions: 'แสดง preview นี้ให้ user ดู, รอ user ตอบยืนยัน, แล้วเรียกอีกครั้งด้วย confirmed=true',
      };
    }

    try {
      const r = await query(
        `INSERT INTO holidays (name, date, type, year, created_by)
         VALUES ($1, $2, $3, EXTRACT(YEAR FROM $2::date)::int, $4)
         RETURNING id, name, date, type`,
        [name, input.date, type, ctx.userId]
      );
      auditFromAI(ctx.userId, 'holiday_create', 'holidays', r.rows[0].id, { name, date: input.date, type });
      return { success: true, action: 'add_holiday', holiday: r.rows[0] };
    } catch (err) {
      if (err.code === '23505') return { error: 'มีวันหยุดในวันนี้อยู่แล้ว' };
      return { error: 'add_holiday failed: ' + err.message };
    }
  },

  async delete_holiday(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!DATE_RE.test(String(input.date || ''))) return { error: 'date ต้องเป็น YYYY-MM-DD' };
    const existing = await query(`SELECT id, name FROM holidays WHERE date = $1`, [input.date]);
    if (!existing.rows[0]) return { error: 'ไม่พบวันหยุดในวันที่ระบุ' };

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'delete_holiday',
        date: input.date,
        name: existing.rows[0].name,
        instructions: 'ยืนยันการลบหรือไม่?',
      };
    }
    await query(`DELETE FROM holidays WHERE id = $1`, [existing.rows[0].id]);
    auditFromAI(ctx.userId, 'holiday_delete', 'holidays', existing.rows[0].id, { date: input.date, name: existing.rows[0].name });
    return { success: true, action: 'delete_holiday', deleted: existing.rows[0] };
  },

  // -------- write: announcements --------
  async create_announcement(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    const title = String(input.title || '').trim();
    const content = String(input.content || '').trim();
    if (!title || !content) return { error: 'title และ content ว่างไม่ได้' };
    const type = ['info','important','holiday','urgent'].includes(input.type) ? input.type : 'info';

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'create_announcement',
        title,
        content_preview: content.slice(0, 200) + (content.length > 200 ? '…' : ''),
        type,
        audience: 'ทุก role (owner/hr/employee)',
        instructions: 'แสดง preview แล้วรอ user ยืนยัน',
      };
    }
    const r = await query(
      `INSERT INTO announcements (title, content, type, target_roles, created_by)
       VALUES ($1, $2, $3, ARRAY['owner','hr','employee'], $4)
       RETURNING id, title, type, created_at`,
      [title, content, type, ctx.userId]
    );
    auditFromAI(ctx.userId, 'announcement_create', 'announcements', r.rows[0].id, { title, type });
    return { success: true, action: 'create_announcement', announcement: r.rows[0] };
  },

  // -------- write: events --------
  async create_event(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    const title = String(input.title || '').trim();
    if (!title) return { error: 'title ว่างไม่ได้' };
    if (!DATE_RE.test(String(input.start_date || ''))) return { error: 'start_date ต้องเป็น YYYY-MM-DD' };
    if (input.end_date && !DATE_RE.test(String(input.end_date))) return { error: 'end_date ต้องเป็น YYYY-MM-DD' };
    if (input.start_time && !TIME_RE.test(String(input.start_time))) return { error: 'start_time ต้องเป็น HH:MM' };
    if (input.end_time && !TIME_RE.test(String(input.end_time))) return { error: 'end_time ต้องเป็น HH:MM' };
    const visibility = ['all','department','specific'].includes(input.visibility) ? input.visibility : 'all';

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'create_event',
        title,
        start_date: input.start_date,
        end_date: input.end_date || null,
        start_time: input.start_time || null,
        end_time: input.end_time || null,
        location: input.location || null,
        visibility,
        instructions: 'แสดง preview แล้วรอ user ยืนยัน',
      };
    }
    const r = await query(
      `INSERT INTO calendar_events (title, description, start_date, end_date,
        start_time, end_time, location, visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, start_date`,
      [
        title,
        input.description || null,
        input.start_date,
        input.end_date || null,
        input.start_time || null,
        input.end_time || null,
        input.location || null,
        visibility,
        ctx.userId,
      ]
    );
    auditFromAI(ctx.userId, 'event_create', 'calendar_events', r.rows[0].id, { title, start_date: input.start_date });
    return { success: true, action: 'create_event', event: r.rows[0] };
  },

  // -------- write: leave approve/reject --------
  async approve_leave_request(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.request_id) return { error: 'request_id ว่างไม่ได้' };

    const existing = await query(
      `SELECT lr.*, lt.name AS leave_type,
              e.first_name, e.last_name, e.nickname
         FROM leave_requests lr
         JOIN leave_types lt ON lr.leave_type_id = lt.id
         JOIN employees e ON lr.employee_id = e.id
        WHERE lr.id = $1`,
      [input.request_id]
    );
    const leave = existing.rows[0];
    if (!leave) return { error: 'ไม่พบคำขอ' };
    if (leave.status !== 'pending') return { error: `คำขอนี้สถานะ ${leave.status} แล้ว` };

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'approve_leave_request',
        request: {
          id: leave.id,
          employee: `${leave.first_name} ${leave.last_name}${leave.nickname ? ` (${leave.nickname})` : ''}`,
          leave_type: leave.leave_type,
          start_date: leave.start_date,
          end_date: leave.end_date,
          days_count: leave.days_count,
          reason: leave.reason,
        },
        instructions: 'การอนุมัติจะหัก quota + เขียน attendance_logs โดยอัตโนมัติ. ยืนยันหรือไม่?',
      };
    }

    // Replicate the controller's transaction-safe approval path.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE leave_requests SET status = 'approved', approved_by = $1,
                approved_at = NOW(), hr_notes = $2, updated_at = NOW()
          WHERE id = $3`,
        [ctx.userId, input.hr_notes || null, input.request_id]
      );
      await client.query(
        `UPDATE leave_quotas SET used_days = used_days + $1
          WHERE employee_id = $2 AND leave_type_id = $3
            AND year = EXTRACT(YEAR FROM $4::date)`,
        [leave.days_count, leave.employee_id, leave.leave_type_id, leave.start_date]
      );
      const holidayRes = await client.query(
        `SELECT date::text AS d FROM holidays
          WHERE date BETWEEN $1::date AND $2::date`,
        [leave.start_date, leave.end_date]
      );
      const holidaySet = new Set(holidayRes.rows.map(r => r.d));
      let current = dayjs(leave.start_date);
      const end = dayjs(leave.end_date);
      while (!current.isAfter(end)) {
        const ymd = current.format('YYYY-MM-DD');
        if (current.day() !== 0 && current.day() !== 6 && !holidaySet.has(ymd)) {
          await client.query(
            `INSERT INTO attendance_logs (employee_id, date, status, status_detail)
             VALUES ($1, $2, 'leave', 'ลาที่ได้รับอนุมัติ')
             ON CONFLICT (employee_id, date) DO UPDATE SET status = 'leave', status_detail = 'ลาที่ได้รับอนุมัติ'`,
            [leave.employee_id, ymd]
          );
        }
        current = current.add(1, 'day');
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      return { error: 'approve_leave_request failed: ' + txErr.message };
    } finally {
      client.release();
    }

    // Notify the employee.
    try {
      const empUserId = await userIdFromEmployee(leave.employee_id);
      const rangeText = `${leave.leave_type} ${dayjs(leave.start_date).format('D MMM')}–${dayjs(leave.end_date).format('D MMM')} (${leave.days_count} วัน)`;
      notify(empUserId, {
        type: 'leave_approved',
        title: 'คำขอลาของคุณได้รับการอนุมัติ',
        body: input.hr_notes ? `${rangeText} · "${input.hr_notes}"` : rangeText,
        link: '/leave',
        relatedId: leave.id,
      });
    } catch {}

    auditFromAI(ctx.userId, 'leave_approval', 'leave_requests', leave.id, { action: 'approved', employee_id: leave.employee_id });
    return { success: true, action: 'approve_leave_request', request_id: leave.id };
  },

  async reject_leave_request(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.request_id) return { error: 'request_id ว่างไม่ได้' };
    const reason = String(input.reason || '').trim();
    if (!reason) return { error: 'reason ว่างไม่ได้' };

    const existing = await query(
      `SELECT lr.*, lt.name AS leave_type,
              e.first_name, e.last_name, e.nickname
         FROM leave_requests lr
         JOIN leave_types lt ON lr.leave_type_id = lt.id
         JOIN employees e ON lr.employee_id = e.id
        WHERE lr.id = $1`,
      [input.request_id]
    );
    const leave = existing.rows[0];
    if (!leave) return { error: 'ไม่พบคำขอ' };
    if (leave.status !== 'pending') return { error: `คำขอนี้สถานะ ${leave.status} แล้ว` };

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'reject_leave_request',
        request: {
          id: leave.id,
          employee: `${leave.first_name} ${leave.last_name}`,
          leave_type: leave.leave_type,
          start_date: leave.start_date,
          end_date: leave.end_date,
        },
        reason,
        instructions: 'ยืนยันการปฏิเสธหรือไม่?',
      };
    }
    await query(
      `UPDATE leave_requests SET status = 'rejected', approved_by = $1,
              approved_at = NOW(), hr_notes = $2, updated_at = NOW()
        WHERE id = $3`,
      [ctx.userId, reason, input.request_id]
    );
    try {
      const empUserId = await userIdFromEmployee(leave.employee_id);
      const rangeText = `${leave.leave_type} ${dayjs(leave.start_date).format('D MMM')}–${dayjs(leave.end_date).format('D MMM')}`;
      notify(empUserId, {
        type: 'leave_rejected',
        title: 'คำขอลาของคุณถูกปฏิเสธ',
        body: `${rangeText} · "${reason}"`,
        link: '/leave',
        relatedId: leave.id,
      });
    } catch {}
    auditFromAI(ctx.userId, 'leave_approval', 'leave_requests', leave.id, { action: 'rejected', reason });
    return { success: true, action: 'reject_leave_request', request_id: leave.id };
  },

  // -------- write: OT approve/reject --------
  async approve_ot_request(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.request_id) return { error: 'request_id ว่างไม่ได้' };

    const existing = await query(
      `SELECT o.*, e.first_name, e.last_name, e.nickname
         FROM ot_requests o JOIN employees e ON o.employee_id = e.id
        WHERE o.id = $1`,
      [input.request_id]
    );
    const ot = existing.rows[0];
    if (!ot) return { error: 'ไม่พบคำขอ' };
    if (!['pending','manager_approved'].includes(ot.status)) {
      return { error: `คำขอนี้สถานะ ${ot.status} แล้ว` };
    }

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'approve_ot_request',
        request: {
          id: ot.id,
          employee: `${ot.first_name} ${ot.last_name}`,
          date: ot.date,
          start_time: ot.start_time,
          end_time: ot.end_time,
          hours: ot.hours,
          reason: ot.reason,
        },
        instructions: 'ยืนยันการอนุมัติหรือไม่?',
      };
    }
    await query(
      `UPDATE ot_requests SET status = 'hr_approved', hr_approved_by = $1,
              hr_approved_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [ctx.userId, input.request_id]
    );
    try {
      const empUserId = await userIdFromEmployee(ot.employee_id);
      const bodyText = `${dayjs(ot.date).format('D MMM')} · ${String(ot.start_time).slice(0,5)}–${String(ot.end_time).slice(0,5)} (${ot.hours} ชม.)`;
      notify(empUserId, {
        type: 'ot_approved',
        title: 'คำขอ OT ของคุณได้รับการอนุมัติ',
        body: bodyText,
        link: '/ot',
        relatedId: ot.id,
      });
    } catch {}
    auditFromAI(ctx.userId, 'ot_approval', 'ot_requests', ot.id, { action: 'approved' });
    return { success: true, action: 'approve_ot_request', request_id: ot.id };
  },

  async reject_ot_request(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.request_id) return { error: 'request_id ว่างไม่ได้' };
    const reason = String(input.reason || '').trim();
    if (!reason) return { error: 'reason ว่างไม่ได้' };

    const existing = await query(
      `SELECT o.*, e.first_name, e.last_name FROM ot_requests o
         JOIN employees e ON o.employee_id = e.id WHERE o.id = $1`,
      [input.request_id]
    );
    const ot = existing.rows[0];
    if (!ot) return { error: 'ไม่พบคำขอ' };

    if (input.confirmed !== true) {
      return {
        preview: true,
        action: 'reject_ot_request',
        request: {
          id: ot.id,
          employee: `${ot.first_name} ${ot.last_name}`,
          date: ot.date,
          hours: ot.hours,
        },
        reason,
        instructions: 'ยืนยันการปฏิเสธ?',
      };
    }
    await query(
      `UPDATE ot_requests SET status = 'rejected', rejected_reason = $1,
              updated_at = NOW() WHERE id = $2`,
      [reason, input.request_id]
    );
    try {
      const empUserId = await userIdFromEmployee(ot.employee_id);
      notify(empUserId, {
        type: 'ot_rejected',
        title: 'คำขอ OT ของคุณถูกปฏิเสธ',
        body: `${dayjs(ot.date).format('D MMM')} · "${reason}"`,
        link: '/ot',
        relatedId: ot.id,
      });
    } catch {}
    auditFromAI(ctx.userId, 'ot_approval', 'ot_requests', ot.id, { action: 'rejected', reason });
    return { success: true, action: 'reject_ot_request', request_id: ot.id };
  },

  // -------- write: shift override (one day) --------
  async set_employee_shift_day(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.employee_id) return { error: 'employee_id ว่างไม่ได้' };
    if (!DATE_RE.test(String(input.date || ''))) return { error: 'date ต้องเป็น YYYY-MM-DD' };
    const code = String(input.shift_code || '').trim();
    if (!code) return { error: 'shift_code ว่างไม่ได้' };

    const emp = await query(
      `SELECT id, first_name, last_name, nickname FROM employees WHERE id = $1`,
      [input.employee_id]
    );
    if (!emp.rows[0]) return { error: 'ไม่พบพนักงาน' };

    // Validate shift code unless it's the dayoff sentinel.
    if (code !== 'dayoff') {
      const cfg = await query(`SELECT name FROM shift_configs WHERE code = $1`, [code]);
      if (!cfg.rows[0]) return { error: `ไม่พบกะรหัส ${code}` };
    }

    if (input.confirmed !== true) {
      const existing = await query(
        `SELECT shift_type FROM shift_assignments WHERE employee_id = $1 AND date = $2`,
        [input.employee_id, input.date]
      );
      return {
        preview: true,
        action: 'set_employee_shift_day',
        employee: `${emp.rows[0].first_name} ${emp.rows[0].last_name}`,
        date: input.date,
        new_shift: code,
        previous_shift: existing.rows[0]?.shift_type || '(ไม่มี — ใช้กะประจำ)',
        instructions: 'ยืนยันการเปลี่ยนกะวันนี้?',
      };
    }
    await query(
      `INSERT INTO shift_assignments (employee_id, date, shift_type, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         shift_type = EXCLUDED.shift_type, updated_at = NOW()`,
      [input.employee_id, input.date, code, ctx.userId]
    );
    auditFromAI(ctx.userId, 'shift_override', 'shift_assignments', null, {
      employee_id: input.employee_id, date: input.date, shift_code: code
    });
    return { success: true, action: 'set_employee_shift_day' };
  },

  // -------- write: quota override --------
  async set_employee_quota(input, ctx) {
    const denied = requireAdmin(ctx); if (denied) return denied;
    if (!input.employee_id) return { error: 'employee_id ว่างไม่ได้' };
    const typeName = String(input.leave_type_name || '').trim();
    if (!typeName) return { error: 'leave_type_name ว่างไม่ได้' };
    const totalDays = Number(input.total_days);
    if (!Number.isFinite(totalDays) || totalDays < 0 || totalDays > 366) {
      return { error: 'total_days ต้องเป็นจำนวน 0-366' };
    }
    const year = clampInt(input.year, 2000, 2100, nowLocal().year());

    const lt = await query(
      `SELECT id, name FROM leave_types WHERE name ILIKE $1 LIMIT 1`,
      [typeName]
    );
    if (!lt.rows[0]) return { error: `ไม่พบประเภทลาที่ชื่อ "${typeName}"` };
    const emp = await query(
      `SELECT first_name, last_name FROM employees WHERE id = $1`,
      [input.employee_id]
    );
    if (!emp.rows[0]) return { error: 'ไม่พบพนักงาน' };

    if (input.confirmed !== true) {
      const existing = await query(
        `SELECT total_days, used_days FROM leave_quotas
          WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
        [input.employee_id, lt.rows[0].id, year]
      );
      return {
        preview: true,
        action: 'set_employee_quota',
        employee: `${emp.rows[0].first_name} ${emp.rows[0].last_name}`,
        leave_type: lt.rows[0].name,
        year,
        new_total_days: totalDays,
        previous: existing.rows[0] || null,
        instructions: 'ยืนยันการตั้งโควต้าใหม่?',
      };
    }
    await query(
      `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET
         total_days = EXCLUDED.total_days`,
      [input.employee_id, lt.rows[0].id, year, totalDays]
    );
    auditFromAI(ctx.userId, 'leave_quota_set', 'leave_quotas', null, {
      employee_id: input.employee_id, leave_type: lt.rows[0].name, year, total_days: totalDays
    });
    return { success: true, action: 'set_employee_quota' };
  },
};

// Merge admin handlers — non-admin callers won't see admin tools in the
// catalog (we filter TOOLS by role at request time), but defense in
// depth: each handler also self-checks ctx.role via requireAdmin.
Object.assign(toolHandlers, adminHandlers);

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

    // Owner/HR get the admin tool catalog appended. Employees only see
    // read-only get_my_* tools — so even a prompt-injected attempt to call
    // approve_leave_request would fail with "tool not found" at the API
    // edge before reaching our handler. (Handlers also self-check, so this
    // is defense in depth, not the sole gate.)
    const isAdmin = ctx.role === 'owner' || ctx.role === 'hr';
    const activeTools = isAdmin ? [...TOOLS, ...ADMIN_TOOLS] : TOOLS;

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
        tools: activeTools,
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
