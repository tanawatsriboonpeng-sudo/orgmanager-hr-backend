# OrgManager HR — Backend API

ระบบ Backend สำหรับแอป HR ครบวงจร  
สร้างด้วย **Node.js + Express + PostgreSQL**

---

## โครงสร้างโปรเจกต์

```
hr-backend/
├── src/
│   ├── index.js                  ← Entry point (เริ่มต้น server)
│   ├── routes/
│   │   └── index.js              ← API routes ทั้งหมด
│   ├── controllers/
│   │   ├── authController.js     ← Login, JWT, รหัสผ่าน
│   │   ├── attendanceController.js ← เช็คอิน GPS, เช็คเอาท์
│   │   └── leaveController.js    ← คำขอลา, อนุมัติ, โควตา
│   ├── middleware/
│   │   └── auth.js               ← ตรวจสอบ JWT + Role
│   └── models/
│       ├── migrate.js            ← สร้าง tables ทั้งหมด
│       └── seed.js               ← ข้อมูลเริ่มต้น
├── config/
│   └── database.js               ← เชื่อมต่อ PostgreSQL
├── .env.example                  ← Template ค่าตั้งค่า
├── package.json
└── README.md
```

---

## วิธีติดตั้ง

### สิ่งที่ต้องมีก่อน
- **Node.js** 18+ → https://nodejs.org
- **PostgreSQL** 14+ → https://www.postgresql.org
- **npm** 9+

### ขั้นตอน

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. คัดลอกและแก้ไข .env
cp .env.example .env
# แก้ไขค่า DB_HOST, DB_USER, DB_PASSWORD, JWT_SECRET ใน .env

# 3. สร้างฐานข้อมูลใน PostgreSQL
psql -U postgres -c "CREATE DATABASE orgmanager_hr;"

# 4. สร้าง tables
npm run migrate

# 5. ใส่ข้อมูลเริ่มต้น
npm run seed

# 6. รัน server
npm run dev     # development (auto-reload)
npm start       # production
```

---

## บัญชีทดสอบ (หลัง seed)

| Email | Password | สิทธิ์ |
|-------|----------|-------|
| owner@company.co.th | 1234 | เจ้าของ |
| hr@company.co.th | 1234 | HR Admin |
| somchai@company.co.th | 1234 | พนักงาน |

---

## API Endpoints

### Auth
```
POST   /api/auth/login           เข้าสู่ระบบ
POST   /api/auth/logout          ออกจากระบบ
POST   /api/auth/refresh         ต่ออายุ token
POST   /api/auth/change-password เปลี่ยนรหัสผ่าน
GET    /api/auth/me              ข้อมูลตัวเอง
```

### Attendance (เช็คอิน/เอาท์)
```
POST   /api/attendance/check-in         เช็คอิน (ส่ง lat, lng)
POST   /api/attendance/check-out        เช็คเอาท์
GET    /api/attendance/today            สถานะวันนี้
GET    /api/attendance/my-history       ประวัติของฉัน
GET    /api/attendance/daily-summary    สรุปรายวัน (HR/Owner)
```

### Leave (การลา)
```
GET    /api/leave/types         ประเภทการลา
GET    /api/leave/my-quota      วันลาคงเหลือ
GET    /api/leave/my-history    ประวัติการลา
POST   /api/leave/request       ยื่นคำขอลา
GET    /api/leave/pending       คำขอรออนุมัติ (HR)
PATCH  /api/leave/:id/approve   อนุมัติ/ปฏิเสธ (HR)
```

### OT (ล่วงเวลา)
```
POST   /api/ot/request          ยื่นขอ OT
GET    /api/ot/pending          OT รออนุมัติ (HR)
PATCH  /api/ot/:id/approve      อนุมัติ OT (HR)
```

### Employees
```
GET    /api/employees           รายชื่อพนักงาน (HR/Owner)
GET    /api/employees/me        ข้อมูลตัวเอง
```

### Holidays
```
GET    /api/holidays            วันหยุด
POST   /api/holidays            เพิ่มวันหยุด (HR)
DELETE /api/holidays/:id        ลบวันหยุด (HR)
```

### Announcements
```
GET    /api/announcements           ประกาศ
POST   /api/announcements           สร้างประกาศ (HR/Owner)
POST   /api/announcements/:id/read  อ่านแล้ว
```

### Projects & Tasks (ClickUp-style)
```
GET    /api/projects            รายการโปรเจกต์
POST   /api/projects            สร้างโปรเจกต์
GET    /api/projects/:id/tasks  งานในโปรเจกต์
POST   /api/tasks               สร้างงาน
PATCH  /api/tasks/:id           อัปเดตสถานะงาน
```

### Audit
```
GET    /api/audit-logs          บันทึกการใช้งาน (HR/Owner)
```

---

## ตัวอย่าง Request

### Login
```json
POST /api/auth/login
{
  "email": "somchai@company.co.th",
  "password": "1234",
  "role": "employee"
}
```

### เช็คอิน GPS
```json
POST /api/attendance/check-in
Authorization: Bearer <token>
{
  "lat": 13.7563,
  "lng": 100.5018,
  "method": "gps"
}
```

### ยื่นคำขอลา
```json
POST /api/leave/request
Authorization: Bearer <token>
{
  "leaveTypeId": "uuid-ของ-leave-type",
  "startDate": "2025-05-19",
  "endDate": "2025-05-20",
  "reason": "ท่องเที่ยวกับครอบครัว"
}
```

---

## การ Deploy (Production)

### แนะนำ: Railway หรือ Render (ฟรีสำหรับโปรเจกต์เล็ก)

1. Push โค้ดขึ้น GitHub
2. สร้าง project ใหม่บน Railway.app
3. เชื่อม GitHub repo
4. เพิ่ม PostgreSQL service
5. ใส่ Environment Variables จาก .env.example
6. Deploy อัตโนมัติ

### หรือ VPS (DigitalOcean / AWS)
```bash
# ติดตั้ง PM2 สำหรับ process management
npm install -g pm2
pm2 start src/index.js --name orgmanager-hr
pm2 startup
pm2 save
```

---

## ความปลอดภัย
- JWT token หมดอายุ 8 ชั่วโมง
- รหัสผ่าน hash ด้วย bcrypt (cost 12)
- ล็อคบัญชีเมื่อ login ผิด 5 ครั้ง
- Rate limiting ป้องกัน brute force
- Helmet.js ป้องกัน common attacks
- GPS validation ทุก check-in
- Audit log บันทึกทุก action

---

## ขั้นตอนต่อไป
1. **Frontend** — สร้าง React/Next.js เชื่อมกับ API นี้
2. **Mobile** — React Native ใช้ `expo-location` สำหรับ GPS จริง
3. **Line Notify** — ส่งสรุปประจำวันผ่าน Line
4. **Payroll** — เพิ่ม endpoint คำนวณเงินเดือน

---

สร้างโดย OrgManager HR System v1.0
