document.addEventListener('DOMContentLoaded', () => {

// --- Config ---
const api = (path) => `${API_BASE}${path}`;
const creds = { credentials: 'include' };

// --- State ---
let currentRole = null;
let allFiles = [];

// --- DOM ---
const $ = (id) => document.getElementById(id);
const loginPage = $('loginPage');
const mainPage = $('mainPage');
const loginForm = $('loginForm');
const loginError = $('loginError');
const userBadge = $('userBadge');
const uploadSection = $('uploadSection');
const uploadForm = $('uploadForm');
const fileInput = $('fileInput');
const uploadBtn = $('uploadBtn');
const fileName = $('fileName');
const uploadProgress = $('uploadProgress');
const uploadError = $('uploadError');
const fileList = $('fileList');
const dropZone = $('dropZone');
const skeletonLoading = $('skeletonLoading');
const statsBar = $('statsBar');
const searchInput = $('searchInput');

// --- Init ---
checkSession();

// --- Toast ---
function toast(msg, type = 'info') {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type] || icons.info}</span> ${msg}`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 260);
  }, 2800);
}

// --- Session ---
async function checkSession() {
  try {
    const res = await fetch(api('/api/session'), creds);
    const data = await res.json();
    if (data.loggedIn) {
      showMain(data.username, data.role);
    }
  } catch (e) { /* not logged in */ }
}

// --- Login ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value.trim();
  loginError.textContent = '';

  if (!username || !password) {
    loginError.textContent = '请输入用户名和密码';
    return;
  }

  try {
    const res = await fetch(api('/api/login'), {
      ...creds,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { loginError.textContent = data.error; return; }
    showMain(data.username, data.role);
  } catch {
    loginError.textContent = '网络错误，请重试';
  }
});

function showMain(username, role) {
  currentRole = role;
  loginPage.classList.remove('active');
  mainPage.classList.add('active');

  const roleLabel = role === 'admin' ? '管理员' : '用户';
  userBadge.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>
    ${username} · ${roleLabel}
  `;
  userBadge.className = role === 'admin' ? 'admin' : '';

  if (role === 'admin') {
    uploadSection.style.display = 'block';
  }

  loadFiles();
}

// --- Logout ---
$('logoutBtn').addEventListener('click', async () => {
  await fetch(api('/api/logout'), { ...creds, method: 'POST' });
  currentRole = null;
  mainPage.classList.remove('active');
  loginPage.classList.add('active');
  uploadSection.style.display = 'none';
  statsBar.style.display = 'none';
});

// --- File Input ---
dropZone.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    const names = Array.from(fileInput.files).map(f => f.name).join('、');
    fileName.textContent = `已选择：${names}`;
    uploadBtn.disabled = false;
  } else {
    fileName.textContent = '';
    uploadBtn.disabled = true;
  }
});

// Drag & drop
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change'));
  }
});

// --- Upload ---
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files.length) return;

  uploadError.textContent = '';
  uploadBtn.disabled = true;
  uploadProgress.style.display = 'block';
  uploadProgress.value = 0;

  const formData = new FormData();
  for (const f of fileInput.files) formData.append('file', f);

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('/api/files'));
    xhr.withCredentials = true;

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        uploadProgress.value = (ev.loaded / ev.total) * 100;
      }
    };

    await new Promise((resolve, reject) => {
      xhr.onload = () => xhr.status === 200 ? resolve() : reject(JSON.parse(xhr.responseText));
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(formData);
    });

    fileInput.value = '';
    fileName.textContent = '';
    uploadProgress.style.display = 'none';
    uploadProgress.value = 0;
    toast(`成功上传 ${formData.getAll('file').length} 个文件`, 'success');
    loadFiles();
  } catch (err) {
    uploadError.textContent = err.message || err.error || '上传失败';
    toast(err.message || err.error || '上传失败', 'error');
  } finally {
    uploadBtn.disabled = true;
  }
});

// --- Load Files ---
async function loadFiles() {
  // Show skeleton
  skeletonLoading.style.display = 'block';
  fileList.querySelectorAll('.file-item, .empty-state').forEach(el => el.remove());

  try {
    const res = await fetch(api('/api/files'), creds);
    if (!res.ok) throw new Error();
    allFiles = await res.json();

    skeletonLoading.style.display = 'none';
    updateStats(allFiles);
    renderFiles(allFiles);
  } catch {
    skeletonLoading.style.display = 'none';
    fileList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <p>加载失败，请刷新重试</p>
      </div>`;
  }
}

function updateStats(files) {
  statsBar.style.display = 'grid';
  $('statFileCount').textContent = files.length;
  const total = files.reduce((s, f) => s + f.size, 0);
  $('statTotalSize').textContent = formatSize(total);
}

function renderFiles(files) {
  const filtered = filterFiles(files);

  if (filtered.length === 0) {
    const msg = files.length === 0 ? '暂无文件' : '没有匹配的文件';
    fileList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <p>${msg}</p>
      </div>`;
    return;
  }

  fileList.innerHTML = filtered.map(f => {
    const ext = getExt(f.originalName);
    const icon = getFileIcon(ext);
    const typeClass = getFileTypeClass(ext);
    return `
      <div class="file-item">
        <div class="file-icon ${typeClass}">${icon}</div>
        <div class="file-info">
          <div class="name" title="${esc(f.originalName)}">${esc(f.originalName)}</div>
          <div class="meta">
            <span>${formatSize(f.size)}</span>
            <span>·</span>
            <span>${formatDate(f.uploadedAt)}</span>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn-download" data-name="${esc(f.name)}" data-original="${esc(f.originalName)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            下载
          </button>
          ${currentRole === 'admin' ? `
          <button class="btn-delete" data-name="${esc(f.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>
            删除
          </button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Event delegation
  fileList.querySelectorAll('.btn-download').forEach(btn => {
    btn.addEventListener('click', () => downloadFile(btn.dataset.name, btn.dataset.original));
  });
  fileList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.name));
  });
}

// --- Search ---
searchInput.addEventListener('input', () => renderFiles(allFiles));

function filterFiles(files) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return files;
  return files.filter(f => f.originalName.toLowerCase().includes(q));
}

// --- File icon helpers ---
function getExt(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function getFileIcon(ext) {
  const map = {
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', svg: '🖼', webp: '🖼', ico: '🖼',
    pdf: '📄',
    doc: '📝', docx: '📝',
    xls: '📊', xlsx: '📊',
    ppt: '📽', pptx: '📽',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    mp4: '🎬', avi: '🎬', mov: '🎬', mkv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵',
    js: '💻', ts: '💻', jsx: '💻', tsx: '💻', html: '💻', css: '💻',
    py: '💻', java: '💻', c: '💻', cpp: '💻', go: '💻', rs: '💻',
    json: '💻', xml: '💻', yaml: '💻', yml: '💻', sql: '💻',
    txt: '📃', md: '📃',
  };
  return map[ext] || '📁';
}

function getFileTypeClass(ext) {
  const img = ['jpg','jpeg','png','gif','svg','webp','ico','bmp'];
  const doc = ['doc','docx','xls','xlsx','ppt','pptx','pdf'];
  const code = ['js','ts','jsx','tsx','html','css','py','java','c','cpp','go','rs','json','xml','yaml','yml','sql','sh'];
  const archive = ['zip','rar','7z','tar','gz'];
  if (img.includes(ext)) return 'file-type-img';
  if (doc.includes(ext)) return 'file-type-doc';
  if (ext === 'pdf') return 'file-type-pdf';
  if (archive.includes(ext)) return 'file-type-zip';
  if (code.includes(ext)) return 'file-type-code';
  return 'file-type-other';
}

// --- Download ---
function downloadFile(name, originalName) {
  const a = document.createElement('a');
  a.href = api(`/api/files/${encodeURIComponent(name)}`);
  a.download = originalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`开始下载：${originalName}`, 'success');
}

// --- Delete ---
async function deleteFile(name) {
  if (!confirm('确定要删除此文件吗？')) return;
  try {
    const res = await fetch(api(`/api/files/${encodeURIComponent(name)}`), { ...creds, method: 'DELETE' });
    if (!res.ok) throw new Error();
    toast('文件已删除', 'success');
    loadFiles();
  } catch {
    toast('删除失败', 'error');
  }
}

// Refresh
$('refreshBtn').addEventListener('click', () => {
  searchInput.value = '';
  loadFiles();
});

// --- Helpers ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

}); // END DOMContentLoaded
