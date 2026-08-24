// offline.js — IndexedDB outbox + sync client (Group 29)
// Pattern: every offline write becomes a mutation with a client UUID.
// flushOutbox() replays them to POST /api/sync; the server applies each
// exactly once (sync_log idempotency), so retries can never duplicate data.

const OUTBOX_DB = 'sc-lms';
const DEVICE_ID = (() => {
    let id = localStorage.getItem('sc_device');
    if (!id) { id = 'dev-' + crypto.randomUUID(); localStorage.setItem('sc_device', id); }
    return id;
})();

function openOutbox() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OUTBOX_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('outbox'))
                db.createObjectStore('outbox', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('cache'))
                db.createObjectStore('cache', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function queueMutation(entity, payload) {
    const db = await openOutbox();
    const mutation = { id: crypto.randomUUID(), entity, payload, created_at: new Date().toISOString() };
    await new Promise((res, rej) => {
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').add(mutation);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    updateSyncBadge();
    if (navigator.onLine) flushOutbox();
    return mutation;
}

async function getOutbox() {
    const db = await openOutbox();
    return new Promise((res, rej) => {
        const req = db.transaction('outbox').objectStore('outbox').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
}

async function removeMutations(ids) {
    const db = await openOutbox();
    await new Promise((res, rej) => {
        const tx = db.transaction('outbox', 'readwrite');
        ids.forEach(id => tx.objectStore('outbox').delete(id));
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
}

let syncing = false;
async function flushOutbox() {
    if (syncing) return;
    const mutations = await getOutbox();
    if (!mutations.length) { updateSyncBadge(); return; }
    syncing = true;
    try {
        const base = (typeof window !== 'undefined' && window.SC_API_BASE) || '';
        const res = await fetch(base + '/api/sync', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + getToken() },
            body: JSON.stringify({ device_id: DEVICE_ID, mutations })
        });
        if (!res.ok) throw new Error('sync failed');
        const data = await res.json();
        const done = data.results
            .filter(r => ['applied','duplicate_skipped','conflict','rejected'].includes(r.status))
            .map(r => r.id);
        await removeMutations(done);
        localStorage.setItem('sc_last_sync', new Date().toISOString());
        const applied = data.results.filter(r => r.status === 'applied').length;
        if (applied && typeof showToast === 'function') showToast(`Synced ${applied} record${applied>1?'s':''} to head office`);
    } catch (e) {
        console.log('Sync deferred (offline?)', e.message);
    } finally {
        syncing = false;
        updateSyncBadge();
    }
}

// Cache reference data (roster, lessons) so the page works with no signal
async function cachePut(key, value) {
    const db = await openOutbox();
    await new Promise((res, rej) => {
        const tx = db.transaction('cache', 'readwrite');
        const now = new Date().toISOString();
        tx.objectStore('cache').put({ key, value, cached_at: now });
        tx.objectStore('cache').put({ key: key + ':at', value: now, cached_at: now });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
}
async function cacheGet(key) {
    const db = await openOutbox();
    return new Promise((res, rej) => {
        const req = db.transaction('cache').objectStore('cache').get(key);
        req.onsuccess = () => res(req.result?.value ?? null); req.onerror = () => rej(req.error);
    });
}

// ── Sync badge UI ────────────────────────────────────────────────────────────
async function updateSyncBadge() {
    const el = document.getElementById('syncBadge');
    if (!el) return;
    const pending = (await getOutbox()).length;
    const last = localStorage.getItem('sc_last_sync');
    const lastStr = last ? new Date(last).toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}) : 'never';
    if (pending) {
        el.className = 'sync-badge pending';
        el.innerHTML = `<span class="dot"></span> ${pending} pending · tap to sync`;
    } else {
        el.className = 'sync-badge synced';
        el.innerHTML = `<span class="dot"></span> Synced · ${lastStr}`;
    }
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.toggle('show', !navigator.onLine);
}



// ── Read-through cache ──────────────────────────────────────────────────────
// Every GET response is stored in IndexedDB under its endpoint. When the
// network is unavailable the saved copy is served instead, so every screen
// still renders. Callers get {data, stale, cachedAt} and can show a banner.
async function fetchCached(endpoint, options = {}) {
    const base = (typeof window !== 'undefined' && window.SC_API_BASE) || '';
    try {
        const res = await fetch(base + endpoint, {
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
            ...options
        });
        if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return { data: null, stale: false }; }
        const data = await res.json();
        if (!data || data.offline) throw new Error('offline sentinel');
        await cachePut('GET:' + endpoint, data);
        return { data, stale: false, cachedAt: new Date().toISOString() };
    } catch (e) {
        const saved = await cacheGet('GET:' + endpoint);
        const when  = await cacheGet('GET:' + endpoint + ':at');
        if (saved) return { data: saved, stale: true, cachedAt: when || null };
        return { data: null, stale: true, cachedAt: null };
    }
}

// Show/refresh the "working from saved data" banner on any page that has one
function setStaleBanner(stale, cachedAt) {
    const el = document.getElementById('staleBanner');
    if (!el) return;
    if (stale) {
        const when = cachedAt ? new Date(cachedAt).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'earlier';
        el.textContent = `No connection — showing data saved ${when}. Anything you capture now is queued and will sync automatically.`;
        el.classList.add('show');
    } else el.classList.remove('show');
}

// Queue a grade while offline so marking is never blocked in the field
async function queueGrade(submissionId, score, feedback) {
    return queueMutation('grade', { submission_id: submissionId, score: Number(score), feedback: feedback || '' });
}

// How many writes are still waiting, by type — used by the sync panel
async function outboxSummary() {
    const items = await getOutbox();
    const byEntity = {};
    items.forEach(m => { byEntity[m.entity] = (byEntity[m.entity] || 0) + 1; });
    return { total: items.length, byEntity, items };
}

window.addEventListener('online',  () => { flushOutbox(); updateSyncBadge(); });
window.addEventListener('offline', updateSyncBadge);
document.addEventListener('DOMContentLoaded', () => {
    updateSyncBadge();
    if (navigator.onLine) flushOutbox();
});
