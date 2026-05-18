const { query, pool } = require('../../config/database');
const { notify, notifyManyByRole } = require('../middleware/notify');

// Two-way help channel: any authenticated user opens a ticket, HR +
// owner respond. Single-response per ticket (the response field is
// overwritten on re-respond) — simpler than a threaded comments table
// and matches the "ticket + reply" model the user described.

const VALID_CATEGORIES = new Set(['bug', 'help', 'feature', 'hr', 'other']);
const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 5000;
// Match leave/payroll attachment cap — base64 dataURL of a resized
// screenshot is ~50–500KB.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

// Common SELECT used by list + get. Joins requester + responder so the
// frontend renders names without an extra round-trip per row.
const TICKET_SELECT = `
  SELECT t.*,
         requester_emp.first_name  AS requester_first_name,
         requester_emp.last_name   AS requester_last_name,
         requester_emp.nickname    AS requester_nickname,
         requester_emp.avatar_url  AS requester_avatar_url,
         requester_u.email         AS requester_email,
         requester_u.role          AS requester_role,
         responder_emp.first_name  AS responder_first_name,
         responder_emp.last_name   AS responder_last_name,
         responder_emp.avatar_url  AS responder_avatar_url
    FROM support_tickets t
    LEFT JOIN users requester_u ON t.user_id = requester_u.id
    LEFT JOIN employees requester_emp ON requester_emp.user_id = requester_u.id
    LEFT JOIN users responder_u ON t.responded_by = responder_u.id
    LEFT JOIN employees responder_emp ON responder_emp.user_id = responder_u.id
`;

// GET /api/support/tickets
// Employee: own tickets only. HR/owner: everyone's, with optional
// ?status= and ?category= filters. Sorted newest first.
const list = async (req, res) => {
  try {
    const isStaff = req.user.role === 'hr' || req.user.role === 'owner';
    const conditions = [];
    const params = [];
    if (!isStaff) {
      conditions.push(`t.user_id = $${params.length + 1}`);
      params.push(req.user.id);
    }
    if (req.query.status && ['open', 'answered', 'closed'].includes(req.query.status)) {
      conditions.push(`t.status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.category && VALID_CATEGORIES.has(req.query.category)) {
      conditions.push(`t.category = $${params.length + 1}`);
      params.push(req.query.category);
    }
    // Cap to avoid runaway responses; the page can paginate if it ever needs more.
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await query(
      `${TICKET_SELECT} ${where}
        ORDER BY t.created_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /support/tickets error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/support/tickets/:id
// Permission: HR/owner can read any; employee can read only own.
const getOne = async (req, res) => {
  try {
    const r = await query(`${TICKET_SELECT} WHERE t.id = $1`, [req.params.id]);
    const t = r.rows[0];
    if (!t) return res.status(404).json({ success: false, message: 'ไม่พบเรื่อง' });
    const isStaff = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isStaff && t.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึง' });
    }
    res.json({ success: true, data: t });
  } catch (e) {
    console.error('GET /support/tickets/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/support/tickets
// Anyone authenticated can submit. Pulls employee_id from users.email
// match so HR can see which employee opened it without trusting the
// client. Notifies HR + owner.
const create = async (req, res) => {
  const { category, subject, description, attachment } = req.body;
  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({ success: false, message: 'หมวดหมู่ไม่ถูกต้อง' });
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุหัวข้อ' });
  }
  if (subject.length > MAX_SUBJECT) {
    return res.status(400).json({ success: false, message: `หัวข้อยาวเกิน ${MAX_SUBJECT} ตัวอักษร` });
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาอธิบายปัญหา' });
  }
  if (description.length > MAX_DESCRIPTION) {
    return res.status(400).json({ success: false, message: `รายละเอียดยาวเกิน ${MAX_DESCRIPTION} ตัวอักษร` });
  }
  if (attachment && typeof attachment === 'string' && attachment.length > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({ success: false, message: 'ไฟล์แนบใหญ่เกินไป (สูงสุด ~1.5MB)' });
  }
  try {
    const emp = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    const employeeId = emp.rows[0]?.id || null;
    const ins = await query(
      `INSERT INTO support_tickets
         (user_id, employee_id, category, subject, description, attachment)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [req.user.id, employeeId, category, subject.trim(), description.trim(), attachment || null]
    );
    const ticketId = ins.rows[0].id;

    // Notify HR + owner. Don't include the description body — keep
    // notification short, they'll see the full thing in the UI.
    const requesterRow = employeeId
      ? await query(
          `SELECT CONCAT(first_name, ' ', last_name) AS n FROM employees WHERE id = $1`,
          [employeeId]
        )
      : await query(`SELECT email AS n FROM users WHERE id = $1`, [req.user.id]);
    const requesterName = requesterRow.rows[0]?.n || 'พนักงาน';
    const categoryLabel = {
      bug: '🐞 บั๊ก',
      help: '❓ ขอความช่วยเหลือ',
      feature: '✨ ขอฟีเจอร์',
      hr: '👤 เรื่อง HR',
      other: '💬 อื่นๆ',
    }[category];
    notifyManyByRole(['hr', 'owner'], {
      type: 'support_ticket_new',
      title: `${categoryLabel} จาก ${requesterName}`,
      body: subject.trim().slice(0, 120),
      link: `/support?ticket=${ticketId}`,
      relatedId: ticketId,
    });

    res.status(201).json({ success: true, message: 'ส่งเรื่องเรียบร้อย', data: { id: ticketId } });
  } catch (e) {
    console.error('POST /support/tickets error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/support/tickets/:id/respond
// HR/owner posts a response. Flips status to 'answered' (re-openable).
// Body: { response, closeAfter?: bool }. If closeAfter=true, also marks
// closed in the same write — saves the responder a click.
const respond = async (req, res) => {
  const { response, closeAfter } = req.body;
  if (!response || typeof response !== 'string' || !response.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความตอบ' });
  }
  if (response.length > MAX_DESCRIPTION) {
    return res.status(400).json({ success: false, message: `ข้อความตอบยาวเกิน ${MAX_DESCRIPTION} ตัวอักษร` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(
      'SELECT id, user_id, status FROM support_tickets WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!exists.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบเรื่อง' });
    }
    const newStatus = closeAfter ? 'closed' : 'answered';
    // Split the two paths so Postgres doesn't have to reason about
    // parameter type inference inside CASE WHEN expressions — that
    // was the suspected culprit for the 500s some HR users were
    // seeing on "ตอบ + ปิดเรื่อง." Two separate UPDATEs, same
    // transaction.
    if (closeAfter) {
      await client.query(
        `UPDATE support_tickets
            SET hr_response = $1,
                responded_by = $2,
                responded_at = NOW(),
                status = 'closed',
                closed_at = NOW(),
                closed_by = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [response.trim(), req.user.id, req.params.id]
      );
    } else {
      await client.query(
        `UPDATE support_tickets
            SET hr_response = $1,
                responded_by = $2,
                responded_at = NOW(),
                status = 'answered',
                updated_at = NOW()
          WHERE id = $3`,
        [response.trim(), req.user.id, req.params.id]
      );
    }
    await client.query('COMMIT');

    notify(exists.rows[0].user_id, {
      type: closeAfter ? 'support_ticket_closed' : 'support_ticket_answered',
      title: closeAfter ? 'HR ปิดเรื่องของคุณ' : 'HR ตอบเรื่องของคุณแล้ว',
      body: response.trim().slice(0, 120),
      link: `/support?ticket=${req.params.id}`,
      relatedId: req.params.id,
    });
    res.json({ success: true, message: closeAfter ? 'ตอบและปิดเรื่องแล้ว' : 'ตอบเรื่องแล้ว' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Log full stack so Render shows it; include error message in the
    // response so the operator can paste it back without trawling logs.
    // This endpoint is HR/owner-only — no risk of leaking sensitive
    // detail to employees.
    console.error('POST /support/tickets/:id/respond error:', e);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${e.message}` });
  } finally {
    client.release();
  }
};

// POST /api/support/tickets/:id/close
// Either the ticket owner or HR/owner can close. Idempotent — closing
// an already-closed ticket is a no-op success.
const close = async (req, res) => {
  try {
    const r = await query('SELECT id, user_id, status FROM support_tickets WHERE id = $1', [req.params.id]);
    const t = r.rows[0];
    if (!t) return res.status(404).json({ success: false, message: 'ไม่พบเรื่อง' });
    const isStaff = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isStaff && t.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ปิดเรื่องนี้' });
    }
    if (t.status === 'closed') return res.json({ success: true, message: 'ปิดอยู่แล้ว' });
    await query(
      `UPDATE support_tickets
          SET status = 'closed',
              closed_at = NOW(),
              closed_by = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    // If HR closed someone else's ticket, tell the requester.
    if (isStaff && t.user_id !== req.user.id) {
      notify(t.user_id, {
        type: 'support_ticket_closed',
        title: 'HR ปิดเรื่องของคุณแล้ว',
        body: '',
        link: `/support?ticket=${req.params.id}`,
        relatedId: req.params.id,
      });
    }
    res.json({ success: true, message: 'ปิดเรื่องแล้ว' });
  } catch (e) {
    console.error('POST /support/tickets/:id/close error:', e);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${e.message}` });
  }
};

// POST /api/support/tickets/:id/reopen
// Either side can re-open a closed/answered ticket. Resets status to
// 'open' so HR knows there's something new to look at.
const reopen = async (req, res) => {
  try {
    const r = await query('SELECT id, user_id, status FROM support_tickets WHERE id = $1', [req.params.id]);
    const t = r.rows[0];
    if (!t) return res.status(404).json({ success: false, message: 'ไม่พบเรื่อง' });
    const isStaff = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isStaff && t.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เปิดเรื่องนี้' });
    }
    if (t.status === 'open') return res.json({ success: true, message: 'เปิดอยู่แล้ว' });
    await query(
      `UPDATE support_tickets
          SET status = 'open',
              closed_at = NULL,
              closed_by = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    // Tell the other party. If employee re-opened, notify HR/owner;
    // if HR re-opened, notify the requester.
    if (!isStaff) {
      notifyManyByRole(['hr', 'owner'], {
        type: 'support_ticket_reopened',
        title: 'มีเรื่องถูกเปิดใหม่',
        body: '',
        link: `/support?ticket=${req.params.id}`,
        relatedId: req.params.id,
      });
    } else if (t.user_id !== req.user.id) {
      notify(t.user_id, {
        type: 'support_ticket_reopened',
        title: 'HR เปิดเรื่องของคุณใหม่',
        body: '',
        link: `/support?ticket=${req.params.id}`,
        relatedId: req.params.id,
      });
    }
    res.json({ success: true, message: 'เปิดเรื่องใหม่แล้ว' });
  } catch (e) {
    console.error('POST /support/tickets/:id/reopen error:', e);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${e.message}` });
  }
};

module.exports = { list, getOne, create, respond, close, reopen };
