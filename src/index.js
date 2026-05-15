const { execSync } = require('child_process')
try {
  execSync('node src/models/migrate.js', { stdio: 'inherit' })
  execSync('node src/models/seed.js', { stdio: 'inherit' })
} catch(e) { console.log('Migration skipped:', e.message) }
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3001;

// ====== Security Middleware ======
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting — ป้องกัน brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 20,
  message: { success: false, message: 'ลองใหม่หลัง 15 นาที (ส่งคำขอมากเกินไป)' },
  standardHeaders: true,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { success: false, message: 'ลองใหม่อีกครั้ง' },
});

// ====== Body Parsing ======
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ====== Logging ======
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ====== Static Files (Uploads) ======
app.use('/uploads', express.static(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')));

// ====== Routes ======
app.use('/api/auth', authLimiter);
app.use('/api', generalLimiter);
app.use('/api', routes);

// ====== 404 Handler ======
app.use((req, res) => {
  res.status(404).json({ success: false, message: `ไม่พบ endpoint: ${req.method} ${req.path}` });
});

// ====== Global Error Handler ======
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'development' ? err.message : 'เกิดข้อผิดพลาดภายในระบบ',
  });
});

// ====== Start Server ======
app.listen(PORT, () => {
  console.log(`\n🚀 OrgManager HR API`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Mode    : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   API     : http://localhost:${PORT}/api`);
  console.log(`   Health  : http://localhost:${PORT}/api/health\n`);
  console.log('📌 Next steps:');
  console.log('   1. cp .env.example .env  (แก้ไขค่าให้ตรงกับ server)');
  console.log('   2. npm run migrate       (สร้าง tables)');
  console.log('   3. npm run seed          (ใส่ข้อมูลเริ่มต้น)\n');
});

module.exports = app;
