// auth.js — Shared authentication helpers (Group 29) — v2
// Same-origin by default (web + TWA). A native shell can set window.SC_API_BASE
// to the deployed server URL before this script loads.
const API = (typeof window !== 'undefined' && window.SC_API_BASE) || '';

// Build an absolute API link (needed when the frontend is hosted separately,
// e.g. static frontend on Netlify + Express server on Render).
function apiUrl(path) { return API + path; }

function getToken()  { return localStorage.getItem('sc_token'); }
function getUser()   { return JSON.parse(localStorage.getItem('sc_user') || 'null'); }
function saveAuth(token, user) {
    localStorage.setItem('sc_token', token);
    localStorage.setItem('sc_user', JSON.stringify(user));
}
function clearAuth() {
    localStorage.removeItem('sc_token');
    localStorage.removeItem('sc_user');
}

function requireAuth(...allowedRoles) {
    const token = getToken(), user = getUser();
    if (!token || !user) { window.location.href = '/login.html'; return null; }
    if (allowedRoles.length && !allowedRoles.includes(user.role)) {
        window.location.href = '/login.html'; return null;
    }
    return user;
}

async function apiFetch(endpoint, options = {}) {
    const token = getToken();
    try {
        const res = await fetch(API + endpoint, {
            ...options,
            headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}`, ...(options.headers||{}) },
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return null; }
        return res.json();
    } catch {
        return { offline: true };   // no signal — pages fall back to cached data
    }
}

// multipart upload (assignment briefs, lesson slides, submissions)
async function apiUpload(endpoint, formData) {
    const res = await fetch(API + endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` },
        body: formData
    });
    if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return null; }
    return res.json();
}

function populateHeader() {
    const user = getUser();
    if (!user) return;
    const nameEl = document.getElementById('userName');
    const metaEl = document.getElementById('userMeta');
    const avatarEl = document.getElementById('userAvatar');
    if (nameEl)   nameEl.textContent = user.name + ' ' + user.surname;
    if (metaEl)   metaEl.textContent = user.student_number || user.employee_id ||
                     user.schoolName || (user.role==='admin' ? 'Social Coding HQ' : '');
    if (avatarEl) avatarEl.textContent = user.name[0] + user.surname[0];
}

function logout() {
    if (confirm('Log out of Social Coding LMS?')) { clearAuth(); window.location.href = '/login.html'; }
}

function initTheme() {
    const saved = localStorage.getItem('scTheme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = saved === 'dark' ? 'Dark' : 'Light';
}
function toggleTheme() {
    const html = document.documentElement;
    const light = html.getAttribute('data-theme') !== 'dark';
    html.setAttribute('data-theme', light ? 'dark' : 'light');
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = light ? 'Dark' : 'Light';
    localStorage.setItem('scTheme', light ? 'dark' : 'light');
}

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    if (!t) return;
    document.getElementById('toastMsg').textContent = msg;
    t.classList.remove('toast-error','toast-warn');
    if (type === 'error') t.classList.add('toast-error');
    if (type === 'warn')  t.classList.add('toast-warn');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Register the service worker — makes the whole app open offline
if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
