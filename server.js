const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());

const ALLOWED_FILE_EXTS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.xz',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.flac', '.aac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.json', '.xml', '.csv',
  '.psd', '.ai', '.aep', '.prproj', '.mogrt',
  '.jsx', '.jsxbin', '.exe', '.msi'
]);

[UPLOADS_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

// --- Mutex for concurrent JSON file access ---
class Mutex {
  constructor() { this._locked = false; this._queue = []; }
  lock() {
    return new Promise(resolve => {
      if (!this._locked) { this._locked = true; return resolve(); }
      this._queue.push(resolve);
    });
  }
  unlock() {
    if (this._queue.length > 0) { this._queue.shift()(); }
    else { this._locked = false; }
  }
}
const userMutex = new Mutex();
const contentMutex = new Mutex();

async function readJSON(filepath, fallback = {}) {
  try { return JSON.parse(await fs.promises.readFile(filepath, 'utf8')); }
  catch { return fallback; }
}

async function writeJSON(filepath, data) {
  const tmp = filepath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, filepath);
}

// --- Seed default admin ---
async function ensureDefaultAdmin() {
  await userMutex.lock();
  try {
    const users = await readJSON(USERS_FILE, {});
    if (Object.keys(users).length === 0) {
      users.admin = { password: bcrypt.hashSync('admin123', 10), role: 'admin' };
      await writeJSON(USERS_FILE, users);
      console.log('Default admin: admin / admin123 — CHANGE IMMEDIATELY');
    }
  } finally { userMutex.unlock(); }
}
ensureDefaultAdmin();

// --- Path traversal guard ---
function safePath(baseDir, name) {
  const normalized = path.normalize(name);
  const resolved = path.resolve(baseDir, normalized);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return resolved;
}

// --- Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_FILE_EXTS.has(ext)) return cb(null, true);
  cb(new Error(`不支持的文件类型: ${ext}`));
}

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter
});

// --- Helmet ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// --- Morgan ---
app.use(morgan(isProduction ? 'combined' : 'dev'));

// --- CORS ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- CSRF check for state-changing requests ---
function csrfCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*'))) return next();
  if (!origin && !isProduction) return next();
  res.status(403).json({ error: '请求被拒绝' });
}
app.use('/api', csrfCheck);

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    httpOnly: true
  }
}));

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试过于频繁，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: '请求过于频繁' },
  standardHeaders: true,
  legacyHeaders: false
});

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

// --- Helpers ---
function sanitizeError(err) {
  if (isProduction) return '服务器内部错误';
  return err.message || '未知错误';
}

function loginDelay(res, status, body) {
  const ms = 800 + Math.floor(Math.random() * 1200);
  return new Promise(resolve => {
    setTimeout(() => { res.status(status).json(body); resolve(); }, ms);
  });
}

// --- Routes ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// --- Auth ---
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const users = await readJSON(USERS_FILE);
  const user = users[username];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return await loginDelay(res, 401, { error: '用户名或密码错误' });
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

// --- User Management ---
app.get('/api/users', requireAdmin, async (req, res) => {
  const users = await readJSON(USERS_FILE);
  const list = Object.entries(users).map(([username, u]) => ({ username, role: u.role }));
  res.json(list);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需 2-20 位，仅限字母数字下划线' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  await userMutex.lock();
  try {
    const users = await readJSON(USERS_FILE);
    if (users[username]) return res.status(409).json({ error: '用户名已存在' });
    users[username] = { password: bcrypt.hashSync(password, 10), role: role || 'user' };
    await writeJSON(USERS_FILE, users);
    res.json({ ok: true });
  } finally { userMutex.unlock(); }
});

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  if (req.params.username === req.session.user.username) {
    return res.status(400).json({ error: '不能删除自己' });
  }

  await userMutex.lock();
  try {
    const users = await readJSON(USERS_FILE);
    if (!users[req.params.username]) return res.status(404).json({ error: '用户不存在' });
    if (users[req.params.username].role === 'admin') {
      const adminCount = Object.values(users).filter(u => u.role === 'admin').length;
      if (adminCount <= 1) return res.status(400).json({ error: '不能删除最后一个管理员' });
    }
    delete users[req.params.username];
    await writeJSON(USERS_FILE, users);
    res.json({ ok: true });
  } finally { userMutex.unlock(); }
});

app.put('/api/users/:username/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  await userMutex.lock();
  try {
    const users = await readJSON(USERS_FILE);
    if (!users[req.params.username]) return res.status(404).json({ error: '用户不存在' });
    users[req.params.username].password = bcrypt.hashSync(password, 10);
    await writeJSON(USERS_FILE, users);
    res.json({ ok: true });
  } finally { userMutex.unlock(); }
});

app.put('/api/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

  await userMutex.lock();
  try {
    const users = await readJSON(USERS_FILE);
    const user = users[req.session.user.username];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!bcrypt.compareSync(oldPassword, user.password)) return res.status(403).json({ error: '原密码错误' });
    users[req.session.user.username].password = bcrypt.hashSync(newPassword, 10);
    await writeJSON(USERS_FILE, users);
    res.json({ ok: true });
  } finally { userMutex.unlock(); }
});

// --- Files ---
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const names = await fs.promises.readdir(UPLOADS_DIR);
    const stats = await Promise.all(names.map(async name => {
      const stat = await fs.promises.stat(path.join(UPLOADS_DIR, name));
      const match = name.match(/^\d+-(.+)$/);
      return { name, originalName: match ? match[1] : name, size: stat.size, uploadedAt: stat.mtime };
    }));
    stats.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: '读取文件列表失败' });
  }
});

app.get('/api/files/:name', requireAuth, (req, res) => {
  const filePath = safePath(UPLOADS_DIR, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const match = req.params.name.match(/^\d+-(.+)$/);
  const downloadName = match ? match[1] : req.params.name;
  res.download(filePath, downloadName);
});

app.post('/api/files', requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件不能超过 500MB' });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: '未选择文件' });
    res.json({ ok: true, name: req.file.filename, originalName: req.file.originalname });
  });
});

app.delete('/api/files/:name', requireAdmin, (req, res) => {
  const filePath = safePath(UPLOADS_DIR, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// --- Content ---
app.get('/api/content', async (req, res) => {
  const content = await readJSON(CONTENT_FILE, {});
  res.json(content);
});

app.put('/api/content', requireAdmin, async (req, res) => {
  const payload = { ...req.body };
  delete payload._id;
  delete payload.key;

  await contentMutex.lock();
  try {
    await writeJSON(CONTENT_FILE, payload);
    res.json({ ok: true });
  } finally { contentMutex.unlock(); }
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: sanitizeError(err) });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
