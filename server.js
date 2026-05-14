const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');

// Frontend origin for CORS
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
const FRONTEND_ORIGIN = ALLOWED_ORIGINS[0];

// Ensure directories exist
[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Local JSON-based storage
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

function readJSON(filepath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// Seed default admin if no users exist
function ensureDefaultAdmin() {
  const users = readJSON(USERS_FILE, {});
  if (Object.keys(users).length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    users.admin = { password: hash, role: 'admin' };
    writeJSON(USERS_FILE, users);
    console.log('Default admin account created: admin / admin123');
    console.log('CHANGE THIS PASSWORD IMMEDIATELY');
  }
}
ensureDefaultAdmin();

// Path traversal guard
function safePath(baseDir, name) {
  const resolved = path.resolve(baseDir, name);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    return null;
  }
  return resolved;
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// CORS with whitelist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Trust proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));

// Rate limit for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: '登录尝试过于频繁，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

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

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Auth Routes ---
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const users = readJSON(USERS_FILE);
  const user = users[username];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  req.session.user = { username, role: user.role };
  res.json({ ok: true, role: user.role, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, ...req.session.user });
});

// --- User Management (Admin Only) ---
app.get('/api/users', requireAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  const list = Object.entries(users).map(([username, u]) => ({
    username, role: u.role
  }));
  res.json(list);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需 2-20 位，仅限字母数字下划线' });
  if (password.length < 3) return res.status(400).json({ error: '密码至少 3 位' });

  const users = readJSON(USERS_FILE);
  if (users[username]) return res.status(409).json({ error: '用户名已存在' });

  users[username] = { password: bcrypt.hashSync(password, 10), role: role || 'user' };
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  if (req.params.username === req.session.user.username) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  const users = readJSON(USERS_FILE);
  if (!users[req.params.username]) return res.status(404).json({ error: '用户不存在' });
  delete users[req.params.username];
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.put('/api/users/:username/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 3) return res.status(400).json({ error: '密码至少 3 位' });

  const users = readJSON(USERS_FILE);
  if (!users[req.params.username]) return res.status(404).json({ error: '用户不存在' });

  users[req.params.username].password = bcrypt.hashSync(password, 10);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.put('/api/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: '新密码至少 3 位' });

  const users = readJSON(USERS_FILE);
  const user = users[req.session.user.username];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(oldPassword, user.password)) return res.status(403).json({ error: '原密码错误' });

  users[req.session.user.username].password = bcrypt.hashSync(newPassword, 10);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// --- File Routes ---

// List files
app.get('/api/files', requireAuth, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).map(name => {
    const stat = fs.statSync(path.join(UPLOADS_DIR, name));
    const match = name.match(/^\d+-(.+)$/);
    const originalName = match ? match[1] : name;
    return { name, originalName, size: stat.size, uploadedAt: stat.mtime };
  });
  files.sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(files);
});

// Download file
app.get('/api/files/:name', requireAuth, (req, res) => {
  const filePath = safePath(UPLOADS_DIR, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
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
  const filePath = safePath(UPLOADS_DIR, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// --- Content (Public read, Admin write) ---
app.get('/api/content', (req, res) => {
  const content = readJSON(CONTENT_FILE, {});
  res.json(content);
});

app.put('/api/content', requireAdmin, (req, res) => {
  const payload = { ...req.body };
  delete payload._id;
  delete payload.key;
  writeJSON(CONTENT_FILE, payload);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
