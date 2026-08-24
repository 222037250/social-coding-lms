// sw.js — app shell cache so the LMS opens with zero connectivity (Group 29)
const SHELL = 'sc-shell-v14';
const ASSETS = [
    '/shared-theme.css', '/config.js', '/auth.js', '/offline.js',
    '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png',
    '/icons/maskable-192.png', '/icons/maskable-512.png',
    '/icons/logo-mark-white.png', '/icons/logo-mark-dark.png',
    '/icons/logo-full-white.png', '/icons/logo-full-dark.png',
    '/login.html',
    '/facilitator-dashboard.html', '/facilitator-students.html', '/facilitator-attendance.html',
    '/facilitator-assignments.html', '/facilitator-modules.html',
    '/student-dashboard.html', '/student-modules.html', '/student-assignments.html',
    '/student-attendance.html', '/student-marks.html', '/student-readings.html',
    '/admin-dashboard.html', '/admin-reports.html',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET') return;                 // writes go through the outbox
    if (url.pathname.startsWith('/api/')) {
        // network-first for data; page-level code falls back to IndexedDB cache
        e.respondWith(fetch(e.request).catch(() => new Response(
            JSON.stringify({ offline: true }), { headers: { 'Content-Type':'application/json' } })));
        return;
    }
    // cache-first for the app shell
    e.respondWith(caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || fetch(e.request).then(res => {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(e.request, copy));
            return res;
        })));
});
