document.addEventListener('DOMContentLoaded', () => {

// --- State ---
let currentRole = null;

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

// --- Init ---
checkSession();

// --- Session ---
async function checkSession() {
  try {
    const res = await fetch('/api/session');
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
    const res = await fetch('/api/login', {
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

  userBadge.textContent = `${username} (${role === 'admin' ? '管理员' : '用户'})`;
  userBadge.className = role === 'admin' ? 'admin' : '';

  if (role === 'admin') {
    uploadSection.style.display = 'block';
  }

  loadFiles();
}

// --- Logout ---
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  currentRole = null;
  mainPage.classList.remove('active');
  loginPage.classList.add('active');
  uploadSection.style.display = 'none';
});

// --- File Input ---
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    fileName.textContent = `${fileInput.files.length} 个文件已选择`;
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
    xhr.open('POST', '/api/files');

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
    loadFiles();
  } catch (err) {
    uploadError.textContent = err.message || err.error || '上传失败';
  } finally {
    uploadBtn.disabled = false;
  }
});

// --- Load Files ---
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    if (!res.ok) throw new Error();
    const files = await res.json();

    if (files.length === 0) {
      fileList.innerHTML = '<p class="empty-msg">暂无文件</p>';
      return;
    }

    fileList.innerHTML = files.map(f => `
      <div class="file-item">
        <div class="file-info">
          <div class="name" title="${esc(f.originalName)}">${esc(f.originalName)}</div>
          <div class="meta">${formatSize(f.size)} · ${formatDate(f.uploadedAt)}</div>
        </div>
        <div class="file-actions">
          <button class="btn-download" data-name="${esc(f.name)}" data-original="${esc(f.originalName)}">下载</button>
          ${currentRole === 'admin' ? `<button class="btn-delete" data-name="${esc(f.name)}">删除</button>` : ''}
        </div>
      </div>
    `).join('');

    // Use event delegation instead of inline onclick
    fileList.querySelectorAll('.btn-download').forEach(btn => {
      btn.addEventListener('click', () => downloadFile(btn.dataset.name, btn.dataset.original));
    });
    fileList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteFile(btn.dataset.name));
    });
  } catch {
    fileList.innerHTML = '<p class="empty-msg">加载失败，请刷新重试</p>';
  }
}

// --- Download ---
function downloadFile(name, originalName) {
  const a = document.createElement('a');
  a.href = `/api/files/${encodeURIComponent(name)}`;
  a.download = originalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// --- Delete ---
async function deleteFile(name) {
  if (!confirm('确定要删除此文件吗？')) return;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    loadFiles();
  } catch {
    alert('删除失败');
  }
}

// Refresh
$('refreshBtn').addEventListener('click', loadFiles);

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
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

}); // END DOMContentLoaded
