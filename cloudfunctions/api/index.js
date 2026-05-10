const express = require('express');
const multer = require('multer');
const session = require('express-session');
const serverless = require('serverless-http');
const cloudbase = require('@cloudbase/node-sdk');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const tcb = cloudbase.init({});
const db = tcb.database();
const FILES_COLLECTION = 'files';
const USERS_COLLECTION = 'users';

// Seed default users on first deploy
let seedPromise = (async () => {
  try {
    const { data } = await db.collection(USERS_COLLECTION).limit(1).get();
    if (!data || data.length === 0) {
      await db.collection(USERS_COLLECTION).add({ username: 'admin', password: 'admin123', role: 'admin' });
      await db.collection(USERS_COLLECTION).add({ username: 'user', password: 'user123', role: 'user' });
      console.log('Default users seeded');
    }
  } catch (e) {
    console.error('Seed error:', e.message);
  }
})();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'file-share-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// --- Auth ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { data } = await db.collection(USERS_COLLECTION).where({ username }).limit(1).get();
    if (!data || data.length === 0 || data[0].password !== password) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.user = { username, role: data[0].role };
    res.json({ ok: true, role: data[0].role, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, ...req.session.user });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- User Management (Admin Only) ---

// List users
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { data } = await db.collection(USERS_COLLECTION).orderBy('username', 'asc').get();
    // Don't expose passwords
    const users = (data || []).map(u => ({ username: u.username, role: u.role, _id: u._id }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create user
app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需 2-20 位，仅限字母数字下划线' });
    if (password.length < 3) return res.status(400).json({ error: '密码至少 3 位' });

    const { data: existing } = await db.collection(USERS_COLLECTION).where({ username }).limit(1).get();
    if (existing && existing.length > 0) return res.status(409).json({ error: '用户名已存在' });

    await db.collection(USERS_COLLECTION).add({ username, password, role: role || 'user' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user
app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    if (req.params.username === req.session.user.username) {
      return res.status(400).json({ error: '不能删除自己' });
    }
    const { data } = await db.collection(USERS_COLLECTION).where({ username: req.params.username }).limit(1).get();
    if (!data || data.length === 0) return res.status(404).json({ error: '用户不存在' });
    await db.collection(USERS_COLLECTION).doc(data[0]._id).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password
app.put('/api/users/:username/password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 3) return res.status(400).json({ error: '密码至少 3 位' });

    const { data } = await db.collection(USERS_COLLECTION).where({ username: req.params.username }).limit(1).get();
    if (!data || data.length === 0) return res.status(404).json({ error: '用户不存在' });

    await db.collection(USERS_COLLECTION).doc(data[0]._id).update({ password });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change own password (any authenticated user)
app.put('/api/password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: '新密码至少 3 位' });

    const { data } = await db.collection(USERS_COLLECTION).where({ username: req.session.user.username }).limit(1).get();
    if (!data || data.length === 0) return res.status(404).json({ error: '用户不存在' });
    if (data[0].password !== oldPassword) return res.status(403).json({ error: '原密码错误' });

    await db.collection(USERS_COLLECTION).doc(data[0]._id).update({ password: newPassword });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Files ---
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const result = await db.collection(FILES_COLLECTION)
      .orderBy('uploadedAt', 'desc')
      .limit(200)
      .get();
    res.json(result.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  try {
    const safeName = `${Date.now()}-${encodeURIComponent(req.file.originalname)}`;
    const uploadResult = await tcb.uploadFile({ cloudPath: safeName, fileContent: req.file.buffer });
    await db.collection(FILES_COLLECTION).add({
      name: safeName,
      fileId: uploadResult.fileID,
      originalName: req.file.originalname,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    });
    res.json({ ok: true, name: safeName, originalName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});

app.get('/api/files/:name', requireAuth, async (req, res) => {
  try {
    const docs = await db.collection(FILES_COLLECTION).where({ name: req.params.name }).get();
    if (!docs.data || docs.data.length === 0) return res.status(404).json({ error: '文件不存在' });
    const fileRecord = docs.data[0];
    const fileId = fileRecord.fileId || req.params.name;
    const result = await tcb.downloadFile({ fileID: fileId });
    const originalName = fileRecord.originalName || decodeURIComponent(req.params.name.replace(/^\d+-/, ''));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(result.fileContent));
  } catch (err) {
    res.status(404).json({ error: '文件不存在: ' + err.message });
  }
});

app.delete('/api/files/:name', requireAdmin, async (req, res) => {
  try {
    const docs = await db.collection(FILES_COLLECTION).where({ name: req.params.name }).get();
    let fileId = req.params.name;
    if (docs.data && docs.data.length > 0) {
      fileId = docs.data[0].fileId || req.params.name;
    }
    await tcb.deleteFile({ fileList: [fileId] });
    for (const doc of docs.data || []) {
      await db.collection(FILES_COLLECTION).doc(doc._id).remove();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
});

exports.main = serverless(app);
