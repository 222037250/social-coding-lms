# Building an Android APK — Social Coding LMS

## First, understand what the APK will be

Your app is a **web app**: a PWA frontend talking to a Node/Express server and a
database. An APK cannot contain the Node server — Android has no Node runtime.

So the APK is a **native shell around your deployed web app**:

```
[ APK on the phone ]  →  https://your-app.onrender.com  →  Turso database
   full-screen,              (your Express server)
   own icon, no browser UI
```

The offline behaviour still works: the service worker caches the app shell and
IndexedDB queues attendance while there is no signal — exactly as in the browser.
What the APK adds is a real installed app: launcher icon, splash screen, no
address bar, and something the examiner can install from a file.

**Prerequisite: the app must be deployed to a public HTTPS URL first**
(see `DEPLOYMENT.md` — GitHub → Turso → Render). An APK cannot point at
`localhost` or `192.168.x.x`.

---

## Route 1 — PWABuilder (recommended: no Android Studio, ~15 minutes)

PWABuilder (by Microsoft) wraps a deployed PWA in a Trusted Web Activity and
generates a **signed APK** you can install immediately.

1. Deploy the app and confirm the URL works on your phone's browser.
2. Go to **https://www.pwabuilder.com** and paste your URL (e.g.
   `https://social-coding-lms.onrender.com`).
3. It scores your PWA. This project already ships what it checks for:
   `manifest.json` with 192/512 + maskable icons, a service worker, HTTPS,
   `start_url`, `theme_color`, `display: standalone`.
4. Click **Package for stores → Android**.
   - **Package ID**: `org.socialcodingsa.lms` (reverse-domain, lowercase, no spaces)
   - **App name**: Social Coding LMS
   - **Signing key**: choose *Create new* — PWABuilder generates one and returns it
     in the zip. **Keep that keystore file and its passwords.** You need the same
     key to publish updates.
5. Download the zip. It contains:
   - `app-release-signed.apk` → the file to install on a phone
   - `app-release-bundle.aab` → only needed for the Play Store
   - `assetlinks.json` → see step 7
   - `signing.keystore` + `signing-key-info.txt` → store these safely
6. **Install it**: copy the `.apk` to the phone (USB, email, or Google Drive), open
   it, allow "Install unknown apps" when Android asks, install. The app appears in
   the launcher with your icon.
7. **Remove the address bar** (optional but worth doing): the APK is a Trusted Web
   Activity, and Android hides browser UI only if your site proves it trusts the app.
   Put the downloaded `assetlinks.json` at:
   `https://your-app.onrender.com/.well-known/assetlinks.json`
   In this project: create `frontend/.well-known/assetlinks.json`, commit, push
   (Render redeploys automatically), then reinstall the APK. Until this file is
   live, the app still works — it just shows a thin URL bar at the top.

---

## Route 2 — Bubblewrap CLI (same result, done locally)

PWABuilder uses Google's Bubblewrap under the hood. Do it yourself if you prefer
the command line. Needs **JDK 17** and the **Android SDK** installed.

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://your-app.onrender.com/manifest.json
bubblewrap build          # produces app-release-signed.apk
```

Bubblewrap prompts for package ID, app name and signing key, and can download the
JDK/SDK for you the first time.

---

## Route 3 — Capacitor (a true native shell; more work, more control)

Use this only if you later need native features (camera, GPS for session stamping,
push notifications) or want the UI bundled inside the app instead of loaded from
the server.

```bash
npm install @capacitor/core @capacitor/android
npx cap init "Social Coding LMS" org.socialcodingsa.lms --web-dir=frontend
npx cap add android
npx cap sync
npx cap open android      # opens Android Studio → Build → Build APK
```

**Critical difference:** with Capacitor the pages load from inside the app, so
relative `/api/...` calls no longer point at your server. This project is already
prepared for that — set the API base once, before `auth.js` loads, in each page or
in a shared script:

```html
<script>window.SC_API_BASE = 'https://your-app.onrender.com';</script>
<script src="auth.js"></script>
```

You will also need CORS to allow the native origin — `server.js` already uses
`cors()` with defaults, which permits it.

---

## Which one for next week?

**Route 1.** It gives a real installable APK in about fifteen minutes with no
Android toolchain, and the examiner's "the app is on my phone, no terminals"
requirement is satisfied twice over: installed from an APK *and* backed by a
deployed server. Keep Route 3 as a roadmap answer if he asks about native features.

## Demo-day notes

- Free Render services sleep after ~15 minutes idle — open the app 10 minutes
  before presenting so the first launch is instant.
- Install the APK on **two** phones (yours and a teammate's) the day before.
  Sideloading on an unfamiliar phone under time pressure is not a demo you want.
- Have the `.apk` on a flash drive and in your email as backup, and keep the
  PWA "Add to Home Screen" route as a fallback if an install is blocked.
