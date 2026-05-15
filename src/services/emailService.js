const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

const sendOTPEmail = async (to, name, otp) => {
  await transporter.sendMail({
    from: `"สิริคอนส์ HR" <${process.env.SMTP_USER}>`,
    to,
    subject: 'รหัส OTP สำหรับรีเซ็ตรหัสผ่าน',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <div style="background:#1D9E75;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:white;margin:0">🔐 รีเซ็ตรหัสผ่าน</h2>
          <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">บริษัท สิริคอนส์ คอนสตรัคชั่น จำกัด</p>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px;border:1px solid #eee">
          <p style="color:#333">สวัสดี <strong>${name}</strong></p>
          <p style="color:#555;font-size:14px">รหัส OTP สำหรับรีเซ็ตรหัสผ่าน:</p>
          <div style="background:white;border:2px solid #1D9E75;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
            <div style="font-size:36px;font-weight:bold;color:#1D9E75;letter-spacing:8px">${otp}</div>
            <p style="color:#999;font-size:12px;margin:8px 0 0">หมดอายุใน <strong>10 นาที</strong></p>
          </div>
          <p style="color:#888;font-size:12px">หากไม่ได้ขอ กรุณาเพิกเฉย</p>
        </div>
      </div>
    `,
  })
}

const sendWelcomeEmail = async (to, name, employeeId, password) => {
  await transporter.sendMail({
    from: `"สิริคอนส์ HR" <${process.env.SMTP_USER}>`,
    to,
    subject: 'ยินดีต้อนรับสู่ระบบ HR - สิริคอนส์',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <div style="background:#1D9E75;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:white;margin:0">🎉 ยินดีต้อนรับ!</h2>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px;border:1px solid #eee">
          <p style="color:#333">สวัสดี <strong>${name}</strong></p>
          <div style="background:white;border-radius:10px;padding:16px;border:1px solid #eee">
            <table style="width:100%;font-size:14px">
              <tr><td style="color:#888;padding:4px 0">อีเมล:</td><td style="font-weight:bold">${to}</td></tr>
              <tr><td style="color:#888;padding:4px 0">รหัสพนักงาน:</td><td style="font-weight:bold">${employeeId}</td></tr>
              <tr><td style="color:#888;padding:4px 0">รหัสผ่าน:</td><td style="font-weight:bold;color:#1D9E75">${password}</td></tr>
            </table>
          </div>
          <p style="color:#E24B4A;font-size:12px;margin-top:12px">⚠️ กรุณาเปลี่ยนรหัสผ่านหลัง Login ครั้งแรก</p>
        </div>
      </div>
    `,
  })
}

module.exports = { sendOTPEmail, sendWelcomeEmail }
