// db.js — Social Coding LMS Database (Group 29) — v2.1
// Seed profiles:
//   'lean' (default) — 2 learners, 1 facilitator, 1 admin. Starter dataset.
//   'demo'           — 10 learners, 5 facilitators, 1 admin. Loaded via the
//                      tiny dot on the login page → POST /api/dev/reseed.
// Real curriculum content ships in ./seed-content and is copied into ./uploads
// at seed time, so slides, worksheets and assignment briefs are real PDFs.

require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, 'seed-content');
const UP_DIR   = path.join(__dirname, 'uploads');

let client;

async function getDb() {
    if (client) return client;
    const mode = process.env.DB_MODE || 'local';
    if (mode === 'turso') {
        if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN)
            throw new Error('TURSO_URL and TURSO_TOKEN must be set in .env for Turso mode');
        client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
        console.log('🌐 Connected to Turso cloud database');
    } else {
        client = createClient({ url: 'file:social_coding.db' });
        console.log('📂 Using local SQLite database');
    }
    await createTables();
    const existing = await get(`SELECT COUNT(*) as cnt FROM users`);
    if (!existing || Number(existing.cnt) === 0)
        await seed(process.env.SEED_PROFILE === 'demo' ? 'demo' : 'lean');
    else console.log('✅ Database already seeded');
    return client;
}

async function run(sql, params = []) { return client.execute({ sql, args: params }); }
async function all(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows.map(r => ({ ...r }));
}
async function get(sql, params = []) { const rows = await all(sql, params); return rows[0] || null; }

// Today ± n days as YYYY-MM-DD in South African time
function d(offsetDays = 0) {
    const dt = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(dt);
}

// Copy a bundled content file into uploads/, return its size in KB (null if missing)
function placeFile(name) {
    try {
        if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });
        fs.copyFileSync(path.join(SEED_DIR, name), path.join(UP_DIR, name));
        return Math.max(1, Math.round(fs.statSync(path.join(UP_DIR, name)).size / 1024));
    } catch { console.warn('⚠ seed-content missing:', name); return null; }
}

async function createTables() {
    const tables = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, surname TEXT NOT NULL,
            email TEXT UNIQUE,
            student_number TEXT UNIQUE,
            employee_id TEXT UNIQUE,
            password TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','facilitator','student')),
            school_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS schools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, location TEXT NOT NULL,
            latitude REAL, longitude REAL,         
            facilitator_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL, title TEXT NOT NULL, lesson_order INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER NOT NULL, title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('slides','document','link','video')),
            file_name TEXT, url TEXT, file_size_kb INTEGER,
            uploaded_by INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL, facilitator_id INTEGER NOT NULL, lesson_id INTEGER,
            session_date TEXT NOT NULL,
            session_type TEXT NOT NULL CHECK(session_type IN ('morning','afternoon','evening')),
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
            opened_at TEXT DEFAULT (datetime('now')), closed_at TEXT,
            start_time TEXT, end_time TEXT,          -- the specific time slot chosen when opening the session, e.g. 08:00 / 08:50
            validated INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(school_id, session_date, session_type))`,
        `CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('present','absent')),
            distance_meters REAL,                   -- distance from school centre at check-in (present rows only)
            checked_in_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(session_id, student_id))`,
        `CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER, title TEXT NOT NULL, description TEXT,
            brief_file TEXT, total_marks INTEGER DEFAULT 100,
            open_date TEXT NOT NULL, due_date TEXT NOT NULL, close_date TEXT NOT NULL,
            marking_due_date TEXT NOT NULL, published INTEGER DEFAULT 1,
            facilitator_id INTEGER NOT NULL, school_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
            notes TEXT, file_name TEXT, is_late INTEGER DEFAULT 0,
            submitted_at TEXT DEFAULT (datetime('now')),
            UNIQUE(assignment_id, student_id))`,
        `CREATE TABLE IF NOT EXISTS marks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id INTEGER NOT NULL UNIQUE,
            score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
            feedback TEXT, graded_by INTEGER NOT NULL,
            graded_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL, description TEXT, category TEXT NOT NULL,
            file_name TEXT, url TEXT, added_by INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS student_profiles (
            user_id INTEGER PRIMARY KEY,          -- 1:1 specialisation of users (role=student)
            grade TEXT,                            -- e.g. 'Grade 10'
            date_of_birth TEXT, gender TEXT,
            guardian_name TEXT, guardian_phone TEXT,
            enrolment_date TEXT, cohort TEXT,      -- e.g. '2025'
            status TEXT NOT NULL DEFAULT 'studying' CHECK(status IN ('studying','completed','withdrawn')))`,
        `CREATE TABLE IF NOT EXISTS facilitator_profiles (
            user_id INTEGER PRIMARY KEY,          -- 1:1 specialisation of users (role=facilitator)
            phone TEXT, qualification TEXT,
            specialisation TEXT, start_date TEXT)`,
        `CREATE TABLE IF NOT EXISTS enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, -- historical record: who studied what, and outcome
            student_id INTEGER NOT NULL, module_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'studying' CHECK(status IN ('studying','completed','withdrawn')),
            enrolled_at TEXT, completed_at TEXT,
            UNIQUE(student_id, module_id))`,
        `CREATE TABLE IF NOT EXISTS sponsors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organisation TEXT NOT NULL,
            contact_person TEXT, email TEXT, phone TEXT,
            focus_area TEXT,                     -- e.g. 'STEM education', 'Digital inclusion'
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','prospective','lapsed')),
            notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS sponsorships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sponsor_id INTEGER NOT NULL,
            school_id INTEGER NOT NULL,
            annual_amount INTEGER,               -- Rand per year
            start_date TEXT, end_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(sponsor_id, school_id))`,
        `CREATE TABLE IF NOT EXISTS sync_log (
            mutation_id TEXT PRIMARY KEY,
            device_id TEXT, user_id INTEGER NOT NULL, entity TEXT NOT NULL,
            applied_at TEXT DEFAULT (datetime('now')))`,
    ];
    for (const sql of tables) await run(sql);
    await migrateColumns();
}

// SQLite has no "ADD COLUMN IF NOT EXISTS" — try each, ignore "duplicate column" errors.
// Lets an already-seeded database pick up the geofenced-attendance columns without a full reset.
async function migrateColumns() {
    const migrations = [
        `ALTER TABLE schools ADD COLUMN latitude REAL`,
        `ALTER TABLE schools ADD COLUMN longitude REAL`,
        `ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`,
        `ALTER TABLE sessions ADD COLUMN opened_at TEXT`,
        `ALTER TABLE sessions ADD COLUMN closed_at TEXT`,
        `ALTER TABLE sessions ADD COLUMN start_time TEXT`,
        `ALTER TABLE sessions ADD COLUMN end_time TEXT`,
        `ALTER TABLE attendance ADD COLUMN distance_meters REAL`,
        `ALTER TABLE attendance ADD COLUMN checked_in_at TEXT`,
    ];
    for (const sql of migrations) { try { await run(sql); } catch { /* column already exists */ } }
}

async function wipeData() {
    for (const t of ['enrollments','student_profiles','facilitator_profiles','sponsorships','sponsors','attendance','sessions','marks','submissions','assignments',
                     'materials','lessons','modules','readings','sync_log','users','schools'])
        await run(`DELETE FROM ${t}`);
}

// ═════════════════════════════════════════════════════════════════════════════
async function seed(profile = 'lean') {
    console.log(`🌱 Seeding '${profile}' dataset...`);
    const hash = pw => bcrypt.hashSync(pw, 10);
    const uid = {};   // login_id -> user id

    // Schools — coordinates seeded so the geofenced check-in works out of the box;
    // admin can update the pin for any school from the Schools tab.
    const schoolData = [
        ['Thembalethu High School','KwaZulu-Natal',-29.6006,30.3794],
        ['Siyabonga Secondary','Limpopo',-23.9045,29.4689],
        ['Isipho High School','Gauteng',-26.2041,28.0473],
        ['Ubuntu Primary','Eastern Cape',-32.2968,26.4194],
        ['Nkosi Secondary','North West',-25.8560,25.6403],
        ['Luthuli High','Mpumalanga',-25.4753,30.9694],
        ['Sizwe Technical','Free State',-29.0852,26.1596],
        ['Phambili Primary','Northern Cape',-28.7282,24.7499],
        ['Masakhane High','Western Cape',-33.9249,18.4241],
        ['Ikusasa Primary','Eastern Cape',-33.0153,27.9116],
    ];
    for (const [n,l,lat,lng] of schoolData)
        await run(`INSERT INTO schools (name,location,latitude,longitude) VALUES (?,?,?,?)`,[n,l,lat,lng]);
    const schools = await all(`SELECT id FROM schools ORDER BY id`);
    const sch = i => Number(schools[i-1].id);

    async function addUser(name, surname, loginId, role, schoolIdx, pw) {
        const isStudent = role === 'student';
        await run(`INSERT INTO users (name,surname,student_number,employee_id,password,role,school_id)
                   VALUES (?,?,?,?,?,?,?)`,
            [name, surname, isStudent ? loginId : null, isStudent ? null : loginId,
             hash(pw), role, schoolIdx ? sch(schoolIdx) : null]);
        const u = await get(`SELECT id FROM users WHERE student_number=? OR employee_id=?`, [loginId, loginId]);
        uid[loginId] = Number(u.id);
    }

    // ── Users ────────────────────────────────────────────────────────────────
    await addUser('System','Admin','ADM-001','admin', null, 'admin123');
    await addUser('Sibusiso','Mkhize','FAC-001','facilitator', 1, 'pass123');
    await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [uid['FAC-001'], sch(1)]);

    let school1Students;
    if (profile === 'demo') {
        for (const [n,s,id,scIdx] of [['Nomsa','Ndlovu','FAC-002',2],['Thabo','Maluleke','FAC-003',3],
                                      ['Lerato','Mabaso','FAC-004',4],['Kagiso','Mohapi','FAC-005',5]]) {
            await addUser(n,s,id,'facilitator',scIdx,'pass123');
            await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [uid[id], sch(scIdx)]);
        }
        for (const [n,s,num,scIdx] of [
            ['Amahle','Dlamini','SC-2025-0001',1],['Sipho','Khumalo','SC-2025-0002',1],
            ['Naledi','Mokoena','SC-2025-0003',1],['Tebogo','Sithole','SC-2025-0004',1],
            ['Zanele','Nkosi','SC-2025-0005',1],['Lungelo','Zulu','SC-2025-0006',1],
            ['Precious','Ndlovu','SC-2025-0007',2],['Bongani','Mthembu','SC-2025-0008',2],
            ['Karabo','Molefe','SC-2025-0009',3],['Ayanda','Mahlangu','SC-2025-0010',4],
        ]) await addUser(n,s,num,'student',scIdx,'pass123');
        school1Students = ['SC-2025-0001','SC-2025-0002','SC-2025-0003','SC-2025-0004','SC-2025-0005','SC-2025-0006'];
    } else {
        await addUser('Amahle','Dlamini','SC-2025-0001','student',1,'pass123');
        await addUser('Sipho','Khumalo','SC-2025-0002','student',1,'pass123');
        school1Students = ['SC-2025-0001','SC-2025-0002'];
    }
    const s1 = school1Students.map(k => uid[k]);

    // ── Specialised profiles ────────────────────────────────────────────────
    const facProfiles = { 'FAC-001':['082 555 0101','PathMakers Certified Facilitator','Python & Web Development', d(-420)],
        'FAC-002':['083 555 0202','PathMakers Certified Facilitator','Web Development', d(-360)],
        'FAC-003':['084 555 0303','PathMakers Certified Facilitator','Digital Literacy', d(-300)],
        'FAC-004':['081 555 0404','PathMakers Certified Facilitator','Python', d(-250)],
        'FAC-005':['079 555 0505','PathMakers Certified Facilitator','Cyber Safety', d(-200)] };
    for (const [eid, [ph,q,sp,sd]] of Object.entries(facProfiles))
        if (uid[eid]) await run(`INSERT INTO facilitator_profiles (user_id,phone,qualification,specialisation,start_date) VALUES (?,?,?,?,?)`,
            [uid[eid], ph, q, sp, sd]);

    const stuProfiles = { // num: [grade, dob, gender, guardian, guardianPhone]
        'SC-2025-0001':['Grade 10','2009-03-14','F','Nomusa Dlamini','082 111 0001'],
        'SC-2025-0002':['Grade 11','2008-07-22','M','Petros Khumalo','083 111 0002'],
        'SC-2025-0003':['Grade 10','2009-01-30','F','Dikeledi Mokoena','084 111 0003'],
        'SC-2025-0004':['Grade 12','2007-11-05','M','Grace Sithole','081 111 0004'],
        'SC-2025-0005':['Grade 11','2008-05-18','F','Sizwe Nkosi','079 111 0005'],
        'SC-2025-0006':['Grade 10','2009-09-02','M','Thandiwe Zulu','082 111 0006'],
        'SC-2025-0007':['Grade 11','2008-02-12','F','Jabu Ndlovu','083 111 0007'],
        'SC-2025-0008':['Grade 12','2007-06-25','M','Lindiwe Mthembu','084 111 0008'],
        'SC-2025-0009':['Grade 10','2009-04-09','M','Refilwe Molefe','081 111 0009'],
        'SC-2025-0010':['Grade 11','2008-10-17','F','Sibongile Mahlangu','079 111 0010'] };
    for (const [num, [g,dob,gen,gn,gp]] of Object.entries(stuProfiles))
        if (uid[num]) await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
            VALUES (?,?,?,?,?,?,?,?,'studying')`, [uid[num], g, dob, gen, gn, gp, d(-180), '2025']);

    // ── Historical data: alumni who COMPLETED (visible to sponsors as progress) ──
    const alumni = profile === 'demo'
        ? [['Thulani','Ngcobo','SC-2024-0012',1],['Buhle','Zwane','SC-2024-0018',1],['Nomvula','Cele','SC-2024-0021',2]]
        : [['Thulani','Ngcobo','SC-2024-0012',1],['Buhle','Zwane','SC-2024-0018',1]];
    for (const [n,s,num,scIdx] of alumni) {
        await addUser(n,s,num,'student',scIdx,'pass123');
        await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
            VALUES (?,?,?,?,?,?,?,?,'completed')`, [uid[num],'Completed (was Grade 12)','2006-08-11','M','','', d(-560),'2024']);
    }


    // ── Curriculum with REAL content files ──────────────────────────────────
    for (const [c,t,de] of [
        ['SC101','Introduction to Python','Variables, control flow, functions and problem solving.'],
        ['SC102','Web Development Fundamentals','HTML, CSS and JavaScript for building real pages.'],
        ['SC103','Digital Literacy & Cyber Safety','Safe, confident and productive use of the internet.'],
    ]) await run(`INSERT INTO modules (code,title,description) VALUES (?,?,?)`,[c,t,de]);
    const mod = {}; for (const m of await all(`SELECT id,code FROM modules`)) mod[m.code] = Number(m.id);

    for (const [c,t,o] of [
        ['SC101','Variables & Data Types',1],['SC101','Control Flow: If & Loops',2],['SC101','Functions',3],
        ['SC102','HTML Structure',1],['SC102','Styling with CSS',2],['SC102','JavaScript Basics',3],
        ['SC103','Staying Safe Online',1],['SC103','Search & Research Skills',2],
    ]) await run(`INSERT INTO lessons (module_id,title,lesson_order) VALUES (?,?,?)`,[mod[c],t,o]);
    const les = {}; for (const l of await all(`SELECT id,module_id,lesson_order FROM lessons`))
        les[`${l.module_id}-${l.lesson_order}`] = Number(l.id);
    const L = (code, order) => les[`${mod[code]}-${order}`];

    for (const [lid,title,kind,fname] of [
        [L('SC101',1),'Lesson 1 Slides — Variables & Data Types','slides','SC101-L1-variables-slides.pdf'],
        [L('SC101',1),'Python Variables Cheat Sheet','document','SC101-L1-cheatsheet.pdf'],
        [L('SC101',2),'Lesson 2 Worksheet — If & Loops (5 exercises)','document','SC101-L2-loops-worksheet.pdf'],
        [L('SC101',3),'Lesson 3 Notes — Functions','document','SC101-L3-functions-notes.pdf'],
        [L('SC102',1),'Lesson 1 Guide — HTML Structure','slides','SC102-L1-html-guide.pdf'],
        [L('SC102',2),'Lesson 2 Guide — Styling with CSS','document','SC102-L2-css-guide.pdf'],
        [L('SC103',1),'Guide — Staying Safe Online','document','SC103-L1-online-safety.pdf'],
    ]) {
        const kb = placeFile(fname);
        await run(`INSERT INTO materials (lesson_id,title,kind,file_name,url,file_size_kb,uploaded_by) VALUES (?,?,?,?,?,?,?)`,
            [lid, title, kind, kb ? fname : null, kb ? null : 'https://docs.python.org/3/tutorial/', kb, uid['FAC-001']]);
    }
    await run(`INSERT INTO materials (lesson_id,title,kind,url,uploaded_by) VALUES (?,?,?,?,?)`,
        [L('SC102',3),'MDN — JavaScript First Steps (online)','link',
         'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps', uid['FAC-001']]);

    // ── Enrollments: current cohort studying, alumni completed ──────────────
    for (let i=0;i<s1.length;i++) {
        // SC101 completed by those who passed A1; SC102 in progress
        const passed = i !== 1;   // Sipho (58) passed too, but keep one 'studying' for variety
        await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at,completed_at) VALUES (?,?,?,?,?)`,
            [s1[i], mod['SC101'], passed?'completed':'studying', d(-180), passed?d(-8):null]);
        await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at) VALUES (?,?,'studying',?)`,
            [s1[i], mod['SC102'], d(-60)]);
    }
    for (const [,,num] of alumni)
        for (const code of ['SC101','SC102','SC103'])
            await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at,completed_at) VALUES (?,?,'completed',?,?)`,
                [uid[num], mod[code], d(-560), d(-310)]);
    if (profile === 'demo')
        for (const num of ['SC-2025-0007','SC-2025-0008','SC-2025-0009','SC-2025-0010'])
            await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at) VALUES (?,?,'studying',?)`,
                [uid[num], mod['SC101'], d(-120)]);

    // ── Sessions & attendance (Thembalethu / FAC-001) ───────────────────────
    const sessionDates = [
        [-28,'morning',L('SC101',1)],[-26,'morning',L('SC101',1)],[-21,'morning',L('SC101',2)],
        [-19,'afternoon',L('SC101',2)],[-14,'morning',L('SC101',3)],[-12,'morning',L('SC102',1)],
        [-7,'afternoon',L('SC102',2)],[-5,'morning',L('SC102',3)],
    ];
    for (const [off,t,lid] of sessionDates)
        await run(`INSERT INTO sessions (school_id,facilitator_id,lesson_id,session_date,session_type,validated) VALUES (?,?,?,?,?,1)`,
            [sch(1), uid['FAC-001'], lid, d(off), t]);
    const ses1 = await all(`SELECT id FROM sessions WHERE school_id=? ORDER BY session_date`, [sch(1)]);
    const absentAt = { 3:0, 5:1 % s1.length, 7:(s1.length>3?3:0) };
    for (let si=0; si<ses1.length; si++)
        for (let sti=0; sti<s1.length; sti++)
            await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,?)`,
                [ses1[si].id, s1[sti], absentAt[si]===sti ? 'absent':'present']);

    if (profile === 'demo') {
        for (const [scIdx, fac, dates, kids] of [
            [2,'FAC-002',[[-8,'morning'],[-3,'morning']],['SC-2025-0007','SC-2025-0008']],
            [3,'FAC-003',[[-6,'afternoon']],['SC-2025-0009']],
        ]) {
            for (const [off,typ] of dates) {
                await run(`INSERT INTO sessions (school_id,facilitator_id,session_date,session_type,validated) VALUES (?,?,?,?,1)`,
                    [sch(scIdx), uid[fac], d(off), typ]);
                const s = await get(`SELECT id FROM sessions WHERE school_id=? AND session_date=? AND session_type=?`,
                    [sch(scIdx), d(off), typ]);
                for (const k of kids)
                    await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,'present')`, [s.id, uid[k]]);
            }
        }
    }

    // ── Assignments: real briefs + every lifecycle state visible today ──────
    async function addAssignment(code,title,desc,briefName,openOff,dueOff,closeOff,facId,schoolId) {
        placeFile(briefName);
        await run(`INSERT INTO assignments (module_id,title,description,brief_file,total_marks,open_date,due_date,close_date,marking_due_date,facilitator_id,school_id)
                   VALUES (?,?,?,?,100,?,?,?,?,?,?)`,
            [mod[code], title, desc, briefName, d(openOff), d(dueOff), d(closeOff), d(dueOff+7), facId, schoolId]);
        return Number((await get(`SELECT id FROM assignments WHERE title=? AND school_id=?`,[title,schoolId])).id);
    }
    const a1 = await addAssignment('SC101','A1 · Python Basics','Variables, types, input and f-strings — one file: about_me.py. Full brief attached.','brief-A1-python-basics.pdf',-25,-18,-16,uid['FAC-001'],sch(1));
    const a2 = await addAssignment('SC101','A2 · Control Flow Challenge','The five worksheet problems in one file: control_flow.py. Full brief attached.','brief-A2-control-flow.pdf',-12,-4,-2,uid['FAC-001'],sch(1));
    const a3 = await addAssignment('SC102','A3 · Build a 2-Page Website','index.html + about.html, linked both ways, styled with CSS. Full brief attached.','brief-A3-website.pdf',-5,3,5,uid['FAC-001'],sch(1));
    await addAssignment('SC102','A4 · JavaScript Mini-Project','An airtime top-up calculator with VAT and bundle maths. Full brief attached.','brief-A4-js-project.pdf',4,14,16,uid['FAC-001'],sch(1));

    // A1 — RETURNED: all submitted, all marked; one below pass; last mark 1 day past SLA
    for (const sid of s1)
        await run(`INSERT INTO submissions (assignment_id,student_id,notes,submitted_at) VALUES (?,?,?,?)`,
            [a1, sid, 'about_me.py attached', d(-19)+' 14:02:00']);
    const sub1 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a1]);
    const g1 = [82,58,92,42,78,88].slice(0, sub1.length);
    for (let i=0;i<sub1.length;i++)
        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
            [sub1[i].id, g1[i],
             g1[i]>=80 ? 'Excellent — clean logic and clear comments.' :
             g1[i]<50  ? 'Below the pass mark — come see me and we will go through it together.' :
                         'Good effort. Practise the input conversion pattern.',
             uid['FAC-001'], (i===sub1.length-1 ? d(-10) : d(-15))+' 10:00:00']);

    // A2 — MARKING WINDOW: most submitted (one late), about half marked
    const lateIdx = s1.length - 1;
    for (let i=0;i<s1.length;i++) {
        if (s1.length > 2 && i === 2) continue;   // in demo, one learner hasn't submitted
        const late = i === lateIdx ? 1 : 0;
        await run(`INSERT INTO submissions (assignment_id,student_id,notes,is_late,submitted_at) VALUES (?,?,?,?,?)`,
            [a2, s1[i], 'control_flow.py attached', late, d(late?-3:-5)+' 09:30:00']);
    }
    const sub2 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a2]);
    const g2=[88,79,95,67];
    for (let i=0;i<Math.max(1, Math.floor(sub2.length/2));i++)
        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
            [sub2[i].id, g2[i%4],
             ['Great problem solving on FizzBuzz!','Watch your loop bounds on Exercise 3.','Perfect score — outstanding work.','Solid; tidy up your comments.'][i%4],
             uid['FAC-001'], d(-2)+' 16:00:00']);

    // A3 — OPEN: one early submission
    await run(`INSERT INTO submissions (assignment_id,student_id,notes) VALUES (?,?,?)`,
        [a3, s1[0], 'site.zip attached — submitted early']);

    // Demo: FAC-002 also has a closed, fully-marked assignment (one mark past SLA)
    if (profile === 'demo') {
        const a5 = await addAssignment('SC101','A1 · Python Basics (Siyabonga)','Variables, types, input and f-strings. Full brief attached.','brief-A1-python-basics.pdf',-16,-10,-8,uid['FAC-002'],sch(2));
        for (const k of ['SC-2025-0007','SC-2025-0008'])
            await run(`INSERT INTO submissions (assignment_id,student_id,notes,submitted_at) VALUES (?,?,?,?)`,
                [a5, uid[k], 'about_me.py attached', d(-11)+' 11:00:00']);
        const sub5 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a5]);
        const g5=[74,61];
        for (let i=0;i<sub5.length;i++)
            await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
                [sub5[i].id, g5[i], 'Marked — see comments in class.', uid['FAC-002'],
                 (i===1 ? d(-2) : d(-6))+' 12:00:00']);   // second mark misses the SLA
    }

    // ── Sponsors & sponsorships (the funders the impact report exists for) ──
    const sponsorRows = profile === 'demo' ? [
        ['Ubuntu Digital Trust','Naledi Khoza','grants@ubuntudigital.org.za','011 555 0142','STEM education','active','Multi-year partner; requires quarterly attendance & outcomes reporting.'],
        ['Kopano Foundation','James van der Merwe','jvdm@kopano.org','021 555 0987','Digital inclusion','active','Funds facilitator stipends at two schools.'],
        ['TechBridge SA','Ayesha Patel','ayesha@techbridge.co.za','012 555 3321','Youth employability','prospective','Site visit scheduled; wants to see delivery evidence first.'],
    ] : [
        ['Ubuntu Digital Trust','Naledi Khoza','grants@ubuntudigital.org.za','011 555 0142','STEM education','active','Requires quarterly attendance & outcomes reporting.'],
    ];
    for (const [o,c,e,p,f2,st,n] of sponsorRows)
        await run(`INSERT INTO sponsors (organisation,contact_person,email,phone,focus_area,status,notes) VALUES (?,?,?,?,?,?,?)`,[o,c,e,p,f2,st,n]);
    const spo = {}; for (const s of await all(`SELECT id,organisation FROM sponsors`)) spo[s.organisation]=Number(s.id);
    const spons = profile === 'demo' ? [
        ['Ubuntu Digital Trust',1,180000],['Ubuntu Digital Trust',2,140000],
        ['Kopano Foundation',2,95000],['Kopano Foundation',3,95000],
    ] : [['Ubuntu Digital Trust',1,180000]];
    for (const [org,scIdx,amt] of spons)
        await run(`INSERT INTO sponsorships (sponsor_id,school_id,annual_amount,start_date,end_date) VALUES (?,?,?,?,?)`,
            [spo[org], sch(scIdx), amt, d(-200), d(165)]);

    // Readings
    for (const [ti,de,c,u] of [
        ['Python for Beginners','Official Python tutorial — start here.','Programming','https://docs.python.org/3/tutorial/'],
        ['Staying Safe Online','National cyber-safety resources.','Cyber Safety','https://staysafeonline.org'],
        ['Intro to Web Dev','MDN Learn: HTML, CSS and JS.','Web Development','https://developer.mozilla.org/en-US/docs/Learn'],
    ]) await run(`INSERT INTO readings (title,description,category,url,added_by) VALUES (?,?,?,?,?)`,[ti,de,c,u,uid['ADM-001']]);

    console.log(`✅ '${profile}' seed complete — real materials in place, all lifecycle states live today`);
}

async function reseed(profile = 'lean') {
    await getDb();
    await wipeData();
    await seed(profile === 'demo' ? 'demo' : 'lean');
}

module.exports = { getDb, run, all, get, reseed };
