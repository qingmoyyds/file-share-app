const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Hardcoded credentials (change for production)
const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  user:  { password: 'user123',  role: 'user'  }
};

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

// --- Auth Routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  req.session.user = { username, role: user.role };
  res.json({ ok: true, role: user.role, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, ...req.session.user });
});

// --- File Routes ---

// List files (any logged-in user)
app.get('/api/files', requireAuth, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).map(name => {
    const stat = fs.statSync(path.join(UPLOADS_DIR, name));
    // Extract original name by stripping timestamp prefix
    const match = name.match(/^\d+-(.+)$/);
    const originalName = match ? match[1] : name;
    return {
      name,
      originalName,
      size: stat.size,
      uploadedAt: stat.mtime
    };
  });
  // Latest first
  files.sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(files);
});

// Download file (any logged-in user)
app.get('/api/files/:name', requireAuth, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  // Extract original name from stored filename
  const match = req.params.name.match(/^\d+-(.+)$/);
  const downloadName = match ? match[1] : req.params.name;
  res.download(filePath, downloadName);
});

// Upload file (admin only)
app.post('/api/files', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  res.json({ ok: true, name: req.file.filename, originalName: req.file.originalname });
});

// Delete file (admin only)
app.delete('/api/files/:name', requireAdmin, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Admin account: admin / admin123');
  console.log('User account:  user  / user123');
});
