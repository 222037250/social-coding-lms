// server.js — Social Coding LMS Backend (Group 29) — v2 "Offline-first LMS"
// Run: node server.js   →   http://localhost:3000

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { getDb, run, all, get, reseed } = require('./db');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'socialcoding_group29_secret';
const MARKING_SLA_DAYS = 7;

// South Africa is UTC+2: using UTC dates would flip deadlines two hours late
// (a submission at 00:30 SAST the day after a deadline would count as on time).
function todaySAST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

// ── File uploads ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')),
});
const upload = multer({
    storage, limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.txt','.md','.png','.jpg','.jpeg','.gif','.mp4','.zip','.py','.html','.css','.js']
            .includes(path.extname(file.originalname).toLowerCase());
        ok ? cb(null, true) : cb(new Error('File type not allowed'));
    }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'login.html')));

// ── Auth ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
    const header = req.headers['authorization'];
    const token  = req.query.token || (header ? header.split(' ')[1] : null);
    if (!token) return res.status(401).json({ error: 'No token' });
    try { req.user = jwt.verify(token, SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
}
const role = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Access denied' });

// Login with STUDENT NUMBER (students) or EMPLOYEE ID (staff)
app.post('/api/auth/login', async (req, res) => {
    try {
        await getDb();
        const { login_id, password } = req.body;
        if (!login_id || !password) return res.status(400).json({ error: 'Login ID and password required' });

        const user = await get(
            `SELECT * FROM users WHERE student_number=? OR employee_id=? OR email=?`,
            [login_id.trim(), login_id.trim().toUpperCase(), login_id.trim().toLowerCase()]);
        if (!user || !bcrypt.compareSync(password, user.password))
            return res.status(401).json({ error: 'Invalid login ID or password' });

        let schoolName = null;
        if (user.school_id) {
            const s = await get(`SELECT name FROM schools WHERE id=?`, [user.school_id]);
            schoolName = s?.name || null;
        }
        const payload = { id:Number(user.id), name:user.name, surname:user.surname, role:user.role,
                          school_id:Number(user.school_id)||null };
        // 30-day tokens: facilitators work offline in the field for extended periods
        const token = jwt.sign(payload, SECRET, { expiresIn: '30d' });
        res.json({ token, user: { ...payload, schoolName,
            student_number: user.student_number, employee_id: user.employee_id } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  CURRICULUM: modules → lessons → materials
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/modules', auth, async (req, res) => {
    try {
        await getDb();
        const modules = await all(`SELECT * FROM modules ORDER BY code`);
        for (const m of modules) {
            m.lessons = await all(`SELECT * FROM lessons WHERE module_id=? ORDER BY lesson_order`, [m.id]);
            for (const l of m.lessons)
                l.materials = await all(
                    `SELECT mat.*, u.name || ' ' || u.surname AS uploaded_by_name
                     FROM materials mat JOIN users u ON u.id=mat.uploaded_by
                     WHERE mat.lesson_id=? ORDER BY mat.created_at`, [l.id]);
            m.assignment_count = Number((await get(
                `SELECT COUNT(*) c FROM assignments WHERE module_id=?`, [m.id]))?.c || 0);
        }
        res.json(modules);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/modules', auth, role('admin','facilitator'), async (req, res) => {
    try {
        await getDb();
        const { code, title, description } = req.body;
        if (!code || !title) return res.status(400).json({ error: 'Code and title required' });
        await run(`INSERT INTO modules (code,title,description) VALUES (?,?,?)`, [code.toUpperCase(), title, description||'']);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: 'Module code already exists' }); }
});

app.post('/api/modules/:id/lessons', auth, role('admin','facilitator'), async (req, res) => {
    try {
        await getDb();
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Lesson title required' });
        const max = await get(`SELECT COALESCE(MAX(lesson_order),0) m FROM lessons WHERE module_id=?`, [req.params.id]);
        await run(`INSERT INTO lessons (module_id,title,lesson_order) VALUES (?,?,?)`,
            [req.params.id, title, Number(max.m)+1]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Upload slides/documents to a lesson — THE "where is the uploading of slides" endpoint
app.post('/api/lessons/:id/materials', auth, role('admin','facilitator'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const { title, kind, url } = req.body;
        if (!title || !kind) return res.status(400).json({ error: 'Title and kind required' });
        if (!req.file && !url)  return res.status(400).json({ error: 'Attach a file or provide a link' });
        await run(`INSERT INTO materials (lesson_id,title,kind,file_name,url,file_size_kb,uploaded_by) VALUES (?,?,?,?,?,?,?)`,
            [req.params.id, title, kind, req.file?.filename || null, url || null,
             req.file ? Math.round(req.file.size/1024) : null, req.user.id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/materials/:id/download', auth, async (req, res) => {
    try {
        await getDb();
        const m = await get(`SELECT * FROM materials WHERE id=?`, [req.params.id]);
        if (!m) return res.status(404).json({ error: 'Not found' });
        if (m.file_name) return res.download(path.join(UPLOADS_DIR, m.file_name));
        if (m.url) return res.redirect(m.url);
        res.status(404).json({ error: 'No file or link' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ASSIGNMENT LIFECYCLE
//  scheduled → open → late_window → closed/marking → returned
// ═════════════════════════════════════════════════════════════════════════════
function lifecycleState(a, today) {
    if (!a.published) return 'draft';
    if (today <  a.open_date)  return 'scheduled';
    if (today <= a.due_date)   return 'open';
    if (today <= a.close_date) return 'late_window';
    return 'closed';
}
function daysBetween(fromISO, toISO) {
    return Math.round((new Date(toISO) - new Date(fromISO)) / 86400000);
}

app.get('/api/assignments', auth, async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const schoolFilter = req.user.role === 'admin' ? '' : 'WHERE a.school_id=?';
        const params = req.user.role === 'admin' ? [] : [req.user.school_id];

        const assignments = await all(`
            SELECT a.*, u.name || ' ' || u.surname AS teacher_name,
                   mo.code AS module_code, mo.title AS module_title,
                   (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) AS submission_count,
                   (SELECT COUNT(*) FROM submissions s JOIN marks mk ON mk.submission_id=s.id
                     WHERE s.assignment_id=a.id) AS graded_count
            FROM assignments a
            JOIN users u ON u.id=a.facilitator_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            ${schoolFilter} ORDER BY a.due_date DESC`, params);

        for (const a of assignments) {
            a.submission_count = Number(a.submission_count);
            a.graded_count     = Number(a.graded_count);
            a.lifecycle        = lifecycleState(a, today);
            a.days_to_due      = daysBetween(today, a.due_date);
            // Marking SLA: clock starts at due_date, facilitator has 7 days
            a.marking_days_left = daysBetween(today, a.marking_due_date);
            a.marking_complete  = a.submission_count > 0 && a.graded_count >= a.submission_count;
            if (a.marking_complete && a.lifecycle === 'closed') a.lifecycle = 'returned';

            if (req.user.role === 'student') {
                const sub = await get(`
                    SELECT s.id, s.is_late, s.submitted_at, s.file_name, m.score, m.feedback
                    FROM submissions s LEFT JOIN marks m ON m.submission_id=s.id
                    WHERE s.assignment_id=? AND s.student_id=?`, [a.id, req.user.id]);
                a.submission = sub || null;
                a.status = !sub ? 'pending' : sub.score != null ? 'graded' : 'submitted';
            }
        }
        res.json(assignments);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Create assignment with full lifecycle dates + brief upload
app.post('/api/assignments', auth, role('facilitator'), upload.single('brief'), async (req, res) => {
    try {
        await getDb();
        const { module_id, title, description, total_marks, open_date, due_date, late_days } = req.body;
        if (!title || !open_date || !due_date)
            return res.status(400).json({ error: 'Title, open date and due date are required' });
        if (due_date < open_date)
            return res.status(400).json({ error: 'Due date must be after open date' });

        const lateDays = Math.max(0, Number(late_days ?? 2));
        const close = new Date(new Date(due_date).getTime() + lateDays*86400000).toISOString().slice(0,10);
        const markingDue = new Date(new Date(due_date).getTime() + MARKING_SLA_DAYS*86400000).toISOString().slice(0,10);

        await run(`INSERT INTO assignments
            (module_id,title,description,brief_file,total_marks,open_date,due_date,close_date,marking_due_date,facilitator_id,school_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [module_id || null, title, description || '', req.file?.filename || null,
             Number(total_marks)||100, open_date, due_date, close, markingDue,
             req.user.id, req.user.school_id]);
        res.json({ success: true, close_date: close, marking_due_date: markingDue,
                   message: `Published. Marking due ${MARKING_SLA_DAYS} days after the deadline: ${markingDue}` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/assignments/:id/brief', auth, async (req, res) => {
    try {
        await getDb();
        const a = await get(`SELECT brief_file FROM assignments WHERE id=?`, [req.params.id]);
        if (!a?.brief_file) return res.status(404).json({ error: 'No brief uploaded' });
        res.download(path.join(UPLOADS_DIR, a.brief_file));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Student submit — enforces the window, flags late
app.post('/api/assignments/:id/submit', auth, role('student'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const a = await get(`SELECT * FROM assignments WHERE id=? AND school_id=?`, [req.params.id, req.user.school_id]);
        if (!a) return res.status(404).json({ error: 'Assignment not found' });

        const state = lifecycleState(a, today);
        if (state === 'scheduled') return res.status(400).json({ error: `Opens on ${a.open_date}` });
        if (state === 'closed' || state === 'returned')
            return res.status(400).json({ error: `Closed on ${a.close_date} — submissions no longer accepted` });

        const isLate = state === 'late_window' ? 1 : 0;
        const existing = await get(`SELECT s.id, m.id AS mark_id FROM submissions s
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE s.assignment_id=? AND s.student_id=?`, [req.params.id, req.user.id]);

        if (existing) {
            // Resubmission is allowed until the window closes — unless already graded
            if (existing.mark_id) return res.status(400).json({ error: 'Already graded — resubmission not allowed' });
            await run(`UPDATE submissions SET notes=?, file_name=COALESCE(?,file_name),
                       is_late=?, submitted_at=datetime('now') WHERE id=?`,
                [req.body.notes || '', req.file?.filename || null, isLate, existing.id]);
            return res.json({ success: true, is_late: !!isLate, resubmitted: true,
                message: isLate ? 'Resubmitted — flagged LATE (after the due date)' : 'Resubmitted — previous version replaced' });
        }

        await run(`INSERT INTO submissions (assignment_id,student_id,notes,file_name,is_late) VALUES (?,?,?,?,?)`,
            [req.params.id, req.user.id, req.body.notes || '', req.file?.filename || null, isLate]);
        res.json({ success: true, is_late: !!isLate,
            message: isLate ? 'Submitted — flagged LATE (after the due date)' : 'Submitted on time' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Marking queue — submissions awaiting grades, sorted by SLA urgency
app.get('/api/marking-queue', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const rows = await all(`
            SELECT s.id AS submission_id, s.notes, s.file_name, s.is_late, s.submitted_at,
                   a.id AS assignment_id, a.title, a.due_date, a.marking_due_date, a.total_marks,
                   mo.code AS module_code,
                   u.name || ' ' || u.surname AS student_name, u.student_number
            FROM submissions s
            JOIN assignments a ON a.id=s.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            JOIN users u ON u.id=s.student_id
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE a.facilitator_id=? AND m.id IS NULL
            ORDER BY a.marking_due_date ASC, s.submitted_at ASC`, [req.user.id]);
        for (const r of rows) r.sla_days_left = daysBetween(today, r.marking_due_date);
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/submissions/:id/file', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const s = await get(`SELECT file_name FROM submissions WHERE id=?`, [req.params.id]);
        if (!s?.file_name) return res.status(404).json({ error: 'No file attached' });
        res.download(path.join(UPLOADS_DIR, s.file_name));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/submissions/:id/grade', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const { score, feedback } = req.body;
        const sub = await get(`SELECT s.id, a.total_marks FROM submissions s
            JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?`, [req.params.id]);
        if (!sub) return res.status(404).json({ error: 'Submission not found' });
        const max = Number(sub.total_marks) || 100;
        if (score == null || score < 0 || score > max)
            return res.status(400).json({ error: `Score must be 0–${max} (this assignment is out of ${max})` });
        const existing = await get(`SELECT id FROM marks WHERE submission_id=?`, [req.params.id]);
        if (existing) return res.status(409).json({ error: 'Already graded' });
        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by) VALUES (?,?,?,?)`,
            [req.params.id, Number(score), feedback || '', req.user.id]);
        res.json({ success: true, message: 'Mark returned to learner' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ATTENDANCE — facilitator roster capture (the 30-second flow)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/roster', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const students = await all(
            `SELECT u.id, u.name, u.surname, u.student_number FROM users u
             LEFT JOIN student_profiles sp ON sp.user_id=u.id
             WHERE u.role='student' AND u.school_id=? AND (sp.status IS NULL OR sp.status='studying')
             ORDER BY u.surname, u.name`, [req.user.school_id]);
        const lessons = await all(
            `SELECT l.id, l.title, mo.code FROM lessons l JOIN modules mo ON mo.id=l.module_id
             ORDER BY mo.code, l.lesson_order`);
        res.json({ students, lessons });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── My Learners: everyone the facilitator teaches (incl. completed alumni) ──
app.get('/api/facilitator/students', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const schoolId = req.user.role === 'admin' ? (req.query.school_id || null) : req.user.school_id;
        const rows = await all(`
            SELECT u.id, u.name, u.surname, u.student_number,
                   sp.grade, sp.cohort, COALESCE(sp.status,'studying') AS status,
                   (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                     WHERE a.student_id=u.id AND a.status='present') AS present,
                   (SELECT COUNT(*) FROM attendance a WHERE a.student_id=u.id) AS att_total,
                   (SELECT ROUND(AVG(m.score*100.0/asg.total_marks))
                      FROM marks m JOIN submissions su ON su.id=m.submission_id
                      JOIN assignments asg ON asg.id=su.assignment_id
                     WHERE su.student_id=u.id) AS avg_pct,
                   (SELECT COUNT(*) FROM enrollments e WHERE e.student_id=u.id AND e.status='completed') AS modules_completed,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id) AS module_codes,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id AND e.status='completed') AS completed_codes
            FROM users u LEFT JOIN student_profiles sp ON sp.user_id=u.id
            WHERE u.role='student' AND u.school_id=?
            ORDER BY COALESCE(sp.status,'studying')='studying' DESC, u.surname`, [schoolId]);
        for (const r of rows) {
            r.attendance_rate = Number(r.att_total) ? Math.round(Number(r.present)/Number(r.att_total)*100) : null;
            r.avg_pct = r.avg_pct != null ? Number(r.avg_pct) : null;
            r.modules_completed = Number(r.modules_completed);
            r.modules = r.module_codes ? String(r.module_codes).split(',') : [];
            r.completed_modules = r.completed_codes ? String(r.completed_codes).split(',') : [];
            r.performance = r.avg_pct == null ? 'unmarked' : (r.avg_pct >= 50 ? 'passing' : 'at_risk');
        }
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Full learner profile: personal details, guardian, enrollment history, attendance, marks
app.get('/api/students/:id/profile', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const u = await get(`
            SELECT u.id, u.name, u.surname, u.student_number, u.school_id, u.created_at,
                   s.name AS school_name, sp.grade, sp.date_of_birth, sp.gender,
                   sp.guardian_name, sp.guardian_phone, sp.enrolment_date, sp.cohort,
                   COALESCE(sp.status,'studying') AS status
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            LEFT JOIN schools s ON s.id=u.school_id
            WHERE u.id=? AND u.role='student'`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Learner not found' });
        if (req.user.role === 'facilitator' && Number(u.school_id) !== Number(req.user.school_id))
            return res.status(403).json({ error: 'This learner is not at your school' });

        u.enrollments = await all(`
            SELECT e.status, e.enrolled_at, e.completed_at, mo.code, mo.title
            FROM enrollments e JOIN modules mo ON mo.id=e.module_id
            WHERE e.student_id=? ORDER BY mo.code`, [req.params.id]);
        const att = await get(`
            SELECT COUNT(*) total, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present
            FROM attendance WHERE student_id=?`, [req.params.id]);
        u.attendance = { total: Number(att?.total||0), present: Number(att?.present||0),
            rate: Number(att?.total) ? Math.round(Number(att.present)/Number(att.total)*100) : null };
        u.marks = await all(`
            SELECT a.title, a.total_marks, m.score, ROUND(m.score*100.0/a.total_marks) AS percentage,
                   m.feedback, m.graded_at, s2.is_late, mo.code AS module_code
            FROM marks m JOIN submissions s2 ON s2.id=m.submission_id
            JOIN assignments a ON a.id=s2.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            WHERE s2.student_id=? ORDER BY m.graded_at DESC`, [req.params.id]);
        u.average_pct = u.marks.length ? Math.round(u.marks.reduce((t,m)=>t+Number(m.percentage),0)/u.marks.length) : null;
        res.json(u);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Shared by the online path and the sync path
async function saveSessionAttendance(user, p) {
    const { session_date, session_type, lesson_id, records } = p;
    if (!session_date || !session_type || !Array.isArray(records))
        throw new Error('session_date, session_type and records[] required');

    // Upsert session (unique per school+date+type) — latest facilitator save wins
    await run(`INSERT INTO sessions (school_id,facilitator_id,lesson_id,session_date,session_type)
               VALUES (?,?,?,?,?)
               ON CONFLICT(school_id,session_date,session_type)
               DO UPDATE SET facilitator_id=excluded.facilitator_id, lesson_id=excluded.lesson_id`,
        [user.school_id, user.id, lesson_id || null, session_date, session_type]);
    const session = await get(`SELECT id FROM sessions WHERE school_id=? AND session_date=? AND session_type=?`,
        [user.school_id, session_date, session_type]);

    for (const r of records)
        await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,?)
                   ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status`,
            [session.id, r.student_id, r.status === 'absent' ? 'absent' : 'present']);

    const present = records.filter(r => r.status !== 'absent').length;
    return { session_id: Number(session.id), present, absent: records.length - present };
}

app.post('/api/attendance/session', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const result = await saveSessionAttendance(req.user, req.body);
        res.json({ success: true, ...result,
            message: `Saved — ${result.present} present, ${result.absent} absent` });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message || 'Server error' }); }
});

app.get('/api/attendance/student', auth, role('student'), async (req, res) => {
    try {
        await getDb();
        const records = await all(`
            SELECT sess.session_date, sess.session_type, sess.validated, att.status,
                   l.title AS lesson_title, mo.code AS module_code
            FROM attendance att
            JOIN sessions sess ON sess.id=att.session_id
            LEFT JOIN lessons l ON l.id=sess.lesson_id
            LEFT JOIN modules mo ON mo.id=l.module_id
            WHERE att.student_id=? ORDER BY sess.session_date DESC`, [req.user.id]);
        const total = records.length, present = records.filter(r=>r.status==='present').length;
        res.json({ records, stats: { total, present, absent: total-present,
            average: total ? Math.round(present/total*100) : 0 } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Admin signs off that a session occurred → data becomes "validated" for reports
app.post('/api/sessions/:id/validate', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`UPDATE sessions SET validated=1 WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  OFFLINE SYNC — outbox pattern, idempotent via client mutation UUIDs
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/sync', auth, async (req, res) => {
    try {
        await getDb();
        const { device_id, mutations } = req.body;
        if (!Array.isArray(mutations)) return res.status(400).json({ error: 'mutations[] required' });

        const results = [];
        for (const m of mutations) {
            if (!m.id || !m.entity) { results.push({ id: m.id, status: 'rejected', reason: 'missing id/entity' }); continue; }

            // Idempotency: if this mutation UUID was already applied, skip silently
            const seen = await get(`SELECT mutation_id FROM sync_log WHERE mutation_id=?`, [m.id]);
            if (seen) { results.push({ id: m.id, status: 'duplicate_skipped' }); continue; }

            try {
                if (m.entity === 'session_attendance' && req.user.role === 'facilitator') {
                    await saveSessionAttendance(req.user, m.payload);
                } else if (m.entity === 'grade' && req.user.role === 'facilitator') {
                    const dup = await get(`SELECT id FROM marks WHERE submission_id=?`, [m.payload.submission_id]);
                    if (dup) { results.push({ id: m.id, status: 'conflict', reason: 'already graded' }); continue; }
                    await run(`INSERT INTO marks (submission_id,score,feedback,graded_by) VALUES (?,?,?,?)`,
                        [m.payload.submission_id, Number(m.payload.score), m.payload.feedback || '', req.user.id]);
                } else if (m.entity === 'assignment' && req.user.role === 'facilitator') {
                    const a = m.payload;
                    if (!a.title || !a.open_date || !a.due_date) {
                        results.push({ id: m.id, status: 'rejected', reason: 'missing assignment fields' }); continue;
                    }
                    const lateDays = Math.max(0, Number(a.late_days ?? 2));
                    const close = new Date(new Date(a.due_date).getTime() + lateDays*86400000).toISOString().slice(0,10);
                    const markingDue = new Date(new Date(a.due_date).getTime() + MARKING_SLA_DAYS*86400000).toISOString().slice(0,10);
                    await run(`INSERT INTO assignments
                        (module_id,title,description,total_marks,open_date,due_date,close_date,marking_due_date,facilitator_id,school_id)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`,
                        [a.module_id || null, a.title, a.description || '', Number(a.total_marks)||100,
                         a.open_date, a.due_date, close, markingDue, req.user.id, req.user.school_id]);
                } else {
                    results.push({ id: m.id, status: 'rejected', reason: 'unknown entity or role' }); continue;
                }
                await run(`INSERT INTO sync_log (mutation_id,device_id,user_id,entity) VALUES (?,?,?,?)`,
                    [m.id, device_id || null, req.user.id, m.entity]);
                results.push({ id: m.id, status: 'applied' });
            } catch (err) {
                results.push({ id: m.id, status: 'error', reason: err.message });
            }
        }
        res.json({ success: true, results, server_time: new Date().toISOString() });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  STUDENT: marks
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/marks', auth, role('student'), async (req, res) => {
    try {
        await getDb();
        const graded = await all(`
            SELECT a.title, a.due_date, a.total_marks, mo.code AS module_code, s.is_late,
                   m.score, m.feedback, m.graded_at,
                   ROUND(m.score*100.0/a.total_marks) AS percentage,
                   u.name || ' ' || u.surname AS teacher_name
            FROM marks m JOIN submissions s ON s.id=m.submission_id
            JOIN assignments a ON a.id=s.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            JOIN users u ON u.id=m.graded_by
            WHERE s.student_id=? ORDER BY m.graded_at DESC`, [req.user.id]);
        const pending = await all(`
            SELECT a.title, a.due_date, a.marking_due_date, s.submitted_at,
                   u.name || ' ' || u.surname AS teacher_name
            FROM submissions s JOIN assignments a ON a.id=s.assignment_id
            JOIN users u ON u.id=a.facilitator_id
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE s.student_id=? AND m.id IS NULL ORDER BY s.submitted_at DESC`, [req.user.id]);
        const avg = graded.length ? Math.round(graded.reduce((t,m)=>t+Number(m.percentage),0)/graded.length) : null;
        res.json({ graded, pending, average: avg });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  READINGS (kept from v1)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/readings', auth, async (req, res) => {
    try {
        await getDb();
        res.json(await all(`
            SELECT r.*, u.name || ' ' || u.surname AS added_by_name
            FROM readings r JOIN users u ON u.id=r.added_by ORDER BY r.created_at DESC`));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/readings/:id/download', auth, async (req, res) => {
    try {
        await getDb();
        const r = await get(`SELECT * FROM readings WHERE id=?`, [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Not found' });
        if (r.file_name) return res.download(path.join(UPLOADS_DIR, r.file_name));
        if (r.url) return res.redirect(r.url);
        res.status(404).json({ error: 'No file' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN: users, schools, and the FUNDER IMPACT REPORT
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/overview', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const n = async q => Number((await get(q))?.c || 0);
        res.json({
            schools:      await n(`SELECT COUNT(*) c FROM schools`),
            students:     await n(`SELECT COUNT(*) c FROM users WHERE role='student'`),
            facilitators: await n(`SELECT COUNT(*) c FROM users WHERE role='facilitator'`),
            sessions:     await n(`SELECT COUNT(*) c FROM sessions`),
            modules:      await n(`SELECT COUNT(*) c FROM modules`),
        });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        res.json(await all(`
            SELECT u.id, u.name, u.surname, u.role, u.student_number, u.employee_id,
                   u.school_id, s.name AS school_name,
                   sp.grade, sp.cohort, COALESCE(sp.status, CASE WHEN u.role='student' THEN 'studying' END) AS student_status,
                   fp.qualification, fp.phone AS fac_phone,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id) AS module_codes
            FROM users u LEFT JOIN schools s ON s.id=u.school_id
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            LEFT JOIN facilitator_profiles fp ON fp.user_id=u.id
            ORDER BY u.role, u.surname`));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { name, surname, login_id, password, role: userRole, school_id,
                grade, date_of_birth, gender, guardian_name, guardian_phone,
                phone, qualification, specialisation } = req.body;
        if (!name || !surname || !login_id || !password || !userRole)
            return res.status(400).json({ error: 'All fields required' });
        const hashed = bcrypt.hashSync(password, 10);
        const isStudent = userRole === 'student';
        await run(`INSERT INTO users (name,surname,student_number,employee_id,password,role,school_id) VALUES (?,?,?,?,?,?,?)`,
            [name, surname, isStudent ? login_id : null, isStudent ? null : login_id.toUpperCase(),
             hashed, userRole, school_id || null]);
        const created = await get(`SELECT id FROM users WHERE student_number=? OR employee_id=?`,
            [login_id, login_id.toUpperCase()]);
        if (isStudent)
            await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
                       VALUES (?,?,?,?,?,?,date('now'),strftime('%Y','now'),'studying')`,
                [created.id, grade||null, date_of_birth||null, gender||null, guardian_name||null, guardian_phone||null]);
        else if (userRole === 'facilitator')
            await run(`INSERT INTO facilitator_profiles (user_id,phone,qualification,specialisation,start_date)
                       VALUES (?,?,?,?,date('now'))`,
                [created.id, phone||null, qualification||null, specialisation||null]);
        if (userRole === 'facilitator' && school_id) {
            const u = await get(`SELECT id FROM users WHERE employee_id=?`, [login_id.toUpperCase()]);
            await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [u.id, school_id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: 'Login ID already exists' }); }
});

app.get('/api/admin/schools', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        res.json(await all(`
            SELECT s.*, u.name || ' ' || u.surname AS facilitator_name,
                   (SELECT COUNT(*) FROM users st WHERE st.school_id=s.id AND st.role='student') AS student_count
            FROM schools s LEFT JOIN users u ON u.id=s.facilitator_id ORDER BY s.name`));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Dashboard stats in the shape the admin dashboard expects
app.get('/api/admin/stats', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const schools = await all(`
            SELECT s.id, s.name,
                (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='student') AS learner_count,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND a.status='present') AS present,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id) AS total_att
            FROM schools s ORDER BY s.name`);
        for (const sc of schools) {
            sc.learner_count = Number(sc.learner_count);
            sc.attendance_rate = Number(sc.total_att) ? Math.round(Number(sc.present)/Number(sc.total_att)*100) : 0;
        }
        const withData = schools.filter(sc => Number(sc.total_att) > 0);
        const sorted = [...withData].sort((a,b) => b.attendance_rate - a.attendance_rate);
        const n = async q => Number((await get(q))?.c || 0);
        res.json({
            totalSchools: schools.length,
            totalLearners: schools.reduce((t,sc)=>t+sc.learner_count,0),
            totalSessions: await n(`SELECT COUNT(*) c FROM sessions`),
            avgAttendance: withData.length ? Math.round(withData.reduce((t,sc)=>t+sc.attendance_rate,0)/withData.length) : 0,
            schools, highest: sorted[0] || null, lowest: sorted[sorted.length-1] || null,
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Move a user to a different school
app.patch('/api/admin/users/:id/school', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`UPDATE users SET school_id=? WHERE id=?`, [req.body.school_id || null, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Remove a user (admins protected; you cannot remove yourself)
app.delete('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        if (Number(req.params.id) === Number(req.user.id))
            return res.status(400).json({ error: 'You cannot remove your own account' });
        const u = await get(`SELECT role FROM users WHERE id=?`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'User not found' });
        if (u.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be removed here' });
        await run(`DELETE FROM student_profiles WHERE user_id=?`, [req.params.id]);
        await run(`DELETE FROM facilitator_profiles WHERE user_id=?`, [req.params.id]);
        await run(`DELETE FROM enrollments WHERE student_id=?`, [req.params.id]);
        await run(`DELETE FROM users WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Add / remove readings (admin library management)
app.post('/api/readings', auth, role('admin'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const { title, category, description, url } = req.body;
        if (!title || !category) return res.status(400).json({ error: 'Title and category required' });
        if (!req.file && !url) return res.status(400).json({ error: 'Attach a file or provide a URL' });
        await run(`INSERT INTO readings (title,description,category,file_name,url,added_by) VALUES (?,?,?,?,?,?)`,
            [title, description || '', category, req.file?.filename || null, url || null, req.user.id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/readings/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM readings WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  EARLY WARNING — which learners need intervention, and why
//  Signals: attendance rate, consecutive absences, missed submissions, marks.
//  Facilitators see their own school; admins see every school.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/at-risk', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const scope = req.user.role === 'facilitator' ? 'AND u.school_id = ?' : '';
        const params = req.user.role === 'facilitator' ? [req.user.school_id] : [];

        const learners = await all(`
            SELECT u.id, u.name, u.surname, u.student_number, u.school_id,
                   sc.name AS school_name, sp.grade, COALESCE(sp.status,'studying') AS status
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            LEFT JOIN schools sc ON sc.id = u.school_id
            WHERE u.role='student' AND COALESCE(sp.status,'studying')='studying' ${scope}
            ORDER BY u.surname`, params);

        const out = [];
        for (const l of learners) {
            const signals = [];
            let score = 0;

            // 1. Overall attendance
            const att = await get(`
                SELECT COUNT(*) total, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present
                FROM attendance WHERE student_id=?`, [l.id]);
            const total = Number(att?.total || 0), present = Number(att?.present || 0);
            const rate = total ? Math.round(present / total * 100) : null;
            if (rate != null && rate < 50)      { score += 40; signals.push(`Attendance ${rate}% — below half of sessions`); }
            else if (rate != null && rate < 70) { score += 22; signals.push(`Attendance ${rate}% — falling behind`); }

            // 2. Consecutive absences (most recent sessions first)
            const recent = await all(`
                SELECT a.status FROM attendance a JOIN sessions s ON s.id=a.session_id
                WHERE a.student_id=? ORDER BY s.session_date DESC LIMIT 4`, [l.id]);
            let streak = 0;
            for (const r of recent) { if (r.status === 'absent') streak++; else break; }
            if (streak >= 3)      { score += 35; signals.push(`Absent ${streak} sessions in a row`); }
            else if (streak === 2){ score += 15; signals.push('Absent the last 2 sessions'); }

            // 3. Assignments that closed without a submission
            const missed = await get(`
                SELECT COUNT(*) c FROM assignments a
                WHERE a.school_id=? AND a.published=1 AND a.close_date < ?
                  AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id=a.id AND s.student_id=?)`,
                [l.school_id, today, l.id]);
            const missedCount = Number(missed?.c || 0);
            if (missedCount >= 2)     { score += 30; signals.push(`${missedCount} assignments never submitted`); }
            else if (missedCount === 1){ score += 14; signals.push('1 assignment never submitted'); }

            // 4. Average mark
            const mk = await get(`
                SELECT COUNT(*) c, AVG(m.score*100.0/a.total_marks) avg
                FROM marks m JOIN submissions s ON s.id=m.submission_id
                JOIN assignments a ON a.id=s.assignment_id
                WHERE s.student_id=?`, [l.id]);
            const avg = mk?.avg != null ? Math.round(Number(mk.avg)) : null;
            if (avg != null && avg < 40)      { score += 35; signals.push(`Average ${avg}% — well below the pass mark`); }
            else if (avg != null && avg < 50) { score += 20; signals.push(`Average ${avg}% — below the pass mark`); }

            // 5. Declining trend across the two most recent marks
            const lastTwo = await all(`
                SELECT m.score*100.0/a.total_marks pct FROM marks m
                JOIN submissions s ON s.id=m.submission_id JOIN assignments a ON a.id=s.assignment_id
                WHERE s.student_id=? ORDER BY m.graded_at DESC LIMIT 2`, [l.id]);
            if (lastTwo.length === 2 && Number(lastTwo[0].pct) < Number(lastTwo[1].pct) - 15) {
                score += 12;
                signals.push(`Marks dropped ${Math.round(Number(lastTwo[1].pct) - Number(lastTwo[0].pct))} points`);
            }

            const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
            if (level !== 'low')
                out.push({ id: Number(l.id), name: l.name, surname: l.surname,
                    student_number: l.student_number, grade: l.grade,
                    school_id: Number(l.school_id), school_name: l.school_name,
                    attendance_rate: rate, average_pct: avg, missed_assignments: missedCount,
                    absent_streak: streak, score, level, signals });
        }
        out.sort((a, b) => b.score - a.score);
        res.json({ generated_at: new Date().toISOString(),
            summary: { flagged: out.length, high: out.filter(x => x.level === 'high').length,
                       medium: out.filter(x => x.level === 'medium').length,
                       reviewed: learners.length },
            learners: out });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Sponsor information (the funders the reporting serves) ──────────────────
app.get('/api/admin/sponsors', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const sponsors = await all(`SELECT * FROM sponsors ORDER BY status='active' DESC, organisation`);
        for (const sp of sponsors) {
            sp.sponsorships = await all(`
                SELECT sp2.id, sp2.annual_amount, sp2.start_date, sp2.end_date,
                       s.id AS school_id, s.name AS school_name, s.location
                FROM sponsorships sp2 JOIN schools s ON s.id=sp2.school_id
                WHERE sp2.sponsor_id=? ORDER BY s.name`, [sp.id]);
            sp.total_annual = sp.sponsorships.reduce((t,x)=>t+Number(x.annual_amount||0),0);
        }
        res.json({ sponsors,
            totals: { count: sponsors.length,
                      active: sponsors.filter(x=>x.status==='active').length,
                      annual_funding: sponsors.reduce((t,x)=>t+x.total_annual,0) } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/sponsors', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { organisation, contact_person, email, phone, focus_area, status, notes } = req.body;
        if (!organisation) return res.status(400).json({ error: 'Organisation name required' });
        await run(`INSERT INTO sponsors (organisation,contact_person,email,phone,focus_area,status,notes) VALUES (?,?,?,?,?,?,?)`,
            [organisation, contact_person||'', email||'', phone||'', focus_area||'',
             ['active','prospective','lapsed'].includes(status) ? status : 'active', notes||'']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/sponsors/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM sponsorships WHERE sponsor_id=?`, [req.params.id]);
        await run(`DELETE FROM sponsors WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
// Link a sponsor to a school (many-to-many with terms)
app.post('/api/admin/sponsors/:id/sponsorships', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { school_id, annual_amount, start_date, end_date } = req.body;
        if (!school_id) return res.status(400).json({ error: 'School required' });
        await run(`INSERT INTO sponsorships (sponsor_id,school_id,annual_amount,start_date,end_date) VALUES (?,?,?,?,?)
                   ON CONFLICT(sponsor_id,school_id) DO UPDATE SET annual_amount=excluded.annual_amount,
                   start_date=excluded.start_date, end_date=excluded.end_date`,
            [req.params.id, school_id, Number(annual_amount)||null, start_date||null, end_date||null]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/sponsorships/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM sponsorships WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// The funder impact report — the artefact head office attaches to a proposal
app.get('/api/reports/impact', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { from, to } = req.query;
        const range = [from || '2000-01-01', to || '2100-01-01'];

        const perSchool = await all(`
            SELECT s.id, s.name, s.location,
                (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='student') AS learners,
                (SELECT COUNT(*) FROM sessions se WHERE se.school_id=s.id AND se.session_date BETWEEN ? AND ?) AS sessions,
                (SELECT COUNT(*) FROM sessions se WHERE se.school_id=s.id AND se.validated=1 AND se.session_date BETWEEN ? AND ?) AS validated_sessions,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND a.status='present' AND se.session_date BETWEEN ? AND ?) AS attendances,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND se.session_date BETWEEN ? AND ?) AS attendance_records
            FROM schools s ORDER BY s.name`, [...range, ...range, ...range, ...range]);

        for (const s of perSchool) {
            s.learners = Number(s.learners); s.sessions = Number(s.sessions);
            s.validated_sessions = Number(s.validated_sessions);
            s.attendance_rate = Number(s.attendance_records)
                ? Math.round(Number(s.attendances)/Number(s.attendance_records)*100) : null;
            s.contact_hours = s.sessions * 2;   // 2-hour sessions (programme standard)
        }

        // Marking-SLA compliance per facilitator
        const sla = await all(`
            SELECT u.id, u.name || ' ' || u.surname AS facilitator, u.employee_id,
                   COUNT(m.id) AS graded,
                   SUM(CASE WHEN date(m.graded_at) <= a.marking_due_date THEN 1 ELSE 0 END) AS within_sla,
                   ROUND(AVG(julianday(m.graded_at) - julianday(a.due_date)),1) AS avg_turnaround_days
            FROM marks m
            JOIN submissions su ON su.id=m.submission_id
            JOIN assignments a ON a.id=su.assignment_id
            JOIN users u ON u.id=m.graded_by
            GROUP BY u.id`);
        for (const r of sla) { r.graded=Number(r.graded); r.within_sla=Number(r.within_sla);
            r.sla_compliance = r.graded ? Math.round(r.within_sla/r.graded*100) : null; }

        const marksAgg = await get(`
            SELECT COUNT(*) c, ROUND(AVG(m.score*100.0/a.total_marks),1) avg,
                   SUM(CASE WHEN m.score*1.0/a.total_marks >= 0.5 THEN 1 ELSE 0 END) passed
            FROM marks m JOIN submissions su ON su.id=m.submission_id
            JOIN assignments a ON a.id=su.assignment_id`);

        const totals = {
            learners_reached: perSchool.reduce((t,s)=>t+s.learners,0),
            sessions_delivered: perSchool.reduce((t,s)=>t+s.sessions,0),
            contact_hours: perSchool.reduce((t,s)=>t+s.contact_hours,0),
            avg_attendance: (() => { const withData = perSchool.filter(s=>s.attendance_rate!=null);
                return withData.length ? Math.round(withData.reduce((t,s)=>t+s.attendance_rate,0)/withData.length) : null; })(),
            assessments_marked: Number(marksAgg?.c||0),
            average_mark: marksAgg?.avg != null ? Number(marksAgg.avg) : null,
            pass_rate: Number(marksAgg?.c) ? Math.round(Number(marksAgg.passed)/Number(marksAgg.c)*100) : null,
            data_integrity: (() => { const t = perSchool.reduce((x,s)=>x+s.sessions,0);
                const v = perSchool.reduce((x,s)=>x+s.validated_sessions,0);
                return t ? Math.round(v/t*100) : null; })(),
        };
        res.json({ generated_at: new Date().toISOString(), range: { from: from||'all', to: to||'all' },
                   totals, per_school: perSchool, marking_sla: sla });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  DEV: dataset switch (behind the tiny dot on the login page)
//  lean = 2 learners, 1 facilitator, 1 admin · demo = 10 learners, 5 facilitators, 1 admin
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/dev/reseed', async (req, res) => {
    try {
        // This endpoint wipes and regenerates the whole database, so it must not
        // be open on a public deployment. Locally it stays open for convenience;
        // in cloud mode it only works if ALLOW_DEMO_RESEED=true is set explicitly.
        const isCloud = (process.env.DB_MODE || 'local') === 'turso';
        if (isCloud && process.env.ALLOW_DEMO_RESEED !== 'true')
            return res.status(403).json({ error: 'Dataset switching is disabled on this deployment.' });

        const profile = req.body?.profile === 'demo' ? 'demo' : 'lean';
        await reseed(profile);
        res.json({ success: true, profile,
            message: profile === 'demo'
                ? 'Full demo dataset loaded: 10 learners (SC-2025-0001…0010), 5 facilitators (FAC-001…005), 1 admin (ADM-001). Passwords unchanged.'
                : 'Starter dataset restored: 2 learners (SC-2025-0001, SC-2025-0002), 1 facilitator (FAC-001), 1 admin (ADM-001).' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Reseed failed' }); }
});

// Convert upload/middleware errors (e.g. disallowed file types) into clean JSON
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const known = err.message === 'File type not allowed' || err.code === 'LIMIT_FILE_SIZE';
    if (!known) console.error(err);
    res.status(known ? 400 : 500).json({ error: known ? err.message : 'Server error' });
});

// School progress for sponsors: studying vs completed, per school and per module
app.get('/api/reports/progress', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const perSchool = await all(`
            SELECT s.id, s.name, s.location,
                SUM(CASE WHEN u.id IS NOT NULL AND COALESCE(sp.status,'studying')='studying' THEN 1 ELSE 0 END) AS studying,
                SUM(CASE WHEN sp.status='completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN sp.status='withdrawn' THEN 1 ELSE 0 END) AS withdrawn
            FROM schools s LEFT JOIN users u ON u.school_id=s.id AND u.role='student'
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            GROUP BY s.id ORDER BY s.name`);
        for (const r of perSchool) {
            r.studying=Number(r.studying||0); r.completed=Number(r.completed||0); r.withdrawn=Number(r.withdrawn||0);
            const done = r.completed + r.withdrawn;
            r.completion_rate = done ? Math.round(r.completed/done*100) : null;
        }
        const perModule = await all(`
            SELECT mo.code, mo.title,
                SUM(CASE WHEN e.status='studying' THEN 1 ELSE 0 END) AS studying,
                SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) AS completed
            FROM modules mo LEFT JOIN enrollments e ON e.module_id=mo.id
            GROUP BY mo.id ORDER BY mo.code`);
        for (const r of perModule) { r.studying=Number(r.studying||0); r.completed=Number(r.completed||0); }
        const totals = {
            studying: perSchool.reduce((t,r)=>t+r.studying,0),
            completed: perSchool.reduce((t,r)=>t+r.completed,0),
            withdrawn: perSchool.reduce((t,r)=>t+r.withdrawn,0),
        };
        res.json({ totals, per_school: perSchool, per_module: perModule });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Sync health — visible proof the offline pipeline is working
app.get('/api/sync/health', auth, async (req, res) => {
    try {
        await getDb();
        const mine = req.user.role === 'admin' ? '' : 'WHERE user_id = ?';
        const params = req.user.role === 'admin' ? [] : [req.user.id];
        const devices = await all(`
            SELECT device_id, COUNT(*) AS applied, MAX(applied_at) AS last_sync,
                   GROUP_CONCAT(DISTINCT entity) AS entities
            FROM sync_log ${mine} GROUP BY device_id ORDER BY last_sync DESC`, params);
        const recent = await all(`
            SELECT mutation_id, device_id, entity, applied_at FROM sync_log ${mine}
            ORDER BY applied_at DESC LIMIT 20`, params);
        res.json({ devices: devices.map(d => ({ ...d, applied: Number(d.applied) })), recent,
                   server_time: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── START ────────────────────────────────────────────────────────────────────
async function start() {
    await getDb();
    app.listen(PORT, '0.0.0.0', () => {
        const nets = require('os').networkInterfaces();
        const lan = Object.values(nets).flat().find(i => i.family==='IPv4' && !i.internal);
        console.log(`
╔════════════════════════════════════════════════════════╗
║   Social Coding LMS v2 — offline-first · Group 29      ║
║   Local:   http://localhost:${PORT}                        ║
║   Mobile:  http://${(lan?.address||'your-ip').padEnd(15)}:${PORT}              ║
╠════════════════════════════════════════════════════════╣
║   ADM-001      / admin123  →  Admin                    ║
║   FAC-001 … FAC-010 / pass123  →  Facilitators         ║
║   SC-2025-0001 / pass123   →  Learner (Amahle)         ║
╠════════════════════════════════════════════════════════╣
║   Full dataset: 10 schools, 180 learners, 10 staff     ║
║   Seeing only one active school? An older small        ║
║   database exists — stop the server, delete            ║
║   social_coding.db, then start it again.               ║
╚════════════════════════════════════════════════════════╝`);
    });
}
start();
