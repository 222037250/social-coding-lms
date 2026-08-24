# Deploying the LMS (free) — so the app lives on your phone, not your laptop

Result: a public HTTPS URL anyone can open, installable on your phone as an app.
You will never open a terminal on demo day.

## Step 1 — Push the code to GitHub (one-time)
1. Create a repo at github.com (e.g. `social-coding-lms`), **without** a README.
2. From the project folder:
   ```bash
   git init
   git add .
   git commit -m "Social Coding LMS v2 — offline-first"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/social-coding-lms.git
   git push -u origin main
   ```
   (`.gitignore` already excludes node_modules, the local DB, and uploads.)

## Step 2 — Create the cloud database (Turso, free)
1. Sign up at https://turso.tech (GitHub login works).
2. Create a database, e.g. `social-coding-lms` (choose a nearby region — `jnb` if offered, else `fra`/`lhr`).
3. Copy the **database URL** (starts `libsql://…`).
4. Create an **auth token** for the database and copy it.

## Step 3 — Deploy on Render (free)
1. Sign up at https://render.com (GitHub login).
2. **New → Web Service** → connect your GitHub repo.
3. Render reads `render.yaml` automatically. If it asks manually:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: **Free**
4. Under **Environment**, set:
   - `DB_MODE` = `turso`
   - `TURSO_URL` = your libsql:// URL
   - `TURSO_TOKEN` = your token
   - `JWT_SECRET` = any long random string
   - `ALLOW_DEMO_RESEED` = `true` **only if** you want the hidden demo-data switch
     to work on the deployed site. Leave it unset for anything resembling real
     data — the switch wipes and regenerates the entire database.
5. Deploy. First boot seeds the demo data into Turso automatically.
6. Your app is live at `https://social-coding-lms.onrender.com` (Render shows the exact URL).

## Step 4 — Install it on your phone
1. Open the URL in Chrome (Android) or Safari (iPhone).
2. Menu → **Add to Home Screen** → it installs with its own icon.
3. Open it from the icon: full-screen app. Log in as FAC-001 once while online
   (this caches the roster) — after that, Attendance opens even in airplane mode.

## Demo-day notes (important)
- **Cold start:** free Render services sleep after ~15 min idle and take ~30–60 s to
  wake. Open the URL 10 minutes before you present so it's warm.
- **Uploads are temporary on the free tier:** files uploaded to Render's disk are
  lost when the service restarts. Database records (users, attendance, marks,
  assignments) persist in Turso. For the alpha, upload your demo slides file
  live during the presentation — that's more convincing anyway. (Beta fix:
  object storage, e.g. Cloudflare R2.)
- **Reseeding:** to reset demo data, delete the tables in Turso's dashboard
  (or `turso db shell` → `DROP TABLE` each) and redeploy — the app reseeds
  date-aware data on boot, so all four assignment lifecycle states show on
  whatever day you demo.
- The examiner can open the URL on **his own phone** — invite him to. Nothing
  demonstrates "deployed" better.
