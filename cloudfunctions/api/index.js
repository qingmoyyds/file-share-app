const express = require('express');
const multer = require('multer');
const session = require('express-session');
const serverless = require('serverless-http');
const cloudbase = require('@cloudbase/node-sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const tcb = cloudbase.init({});
const db = tcb.database();
const FILES_COLLECTION = 'files';

const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  user:  { password: 'user123',  role: 'user' }
};

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

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
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) return res.status(401).json({ error: '用户名或密码错误' });
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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

    // Upload to cloud storage
    const uploadResult = await tcb.uploadFile({
      cloudPath: safeName,
      fileContent: req.file.buffer
    });

    // Save metadata to database
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
    // Look up fileId from database by name
    const docs = await db.collection(FILES_COLLECTION).where({ name: req.params.name }).get();
    if (!docs.data || docs.data.length === 0) {
      return res.status(404).json({ error: '文件不存在' });
    }
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
    // Look up fileId from database
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
