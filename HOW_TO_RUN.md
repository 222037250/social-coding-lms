# Social Coding LMS v2.1 — Offline-first · Group 29

## Run it
```bash
npm install
node server.js
```
Open **http://localhost:3000** (phone on same WiFi: use the `Mobile:` address printed at startup).

## Starter logins (default dataset)
| Login ID | Password | Role |
|---|---|---|
| `ADM-001` | `admin123` | Admin (head office) |
| `FAC-001` | `pass123` | Facilitator — Sibusiso Mkhize, Thembalethu High |
| `SC-2025-0001` | `pass123` | Learner — Amahle Dlamini |
| `SC-2025-0002` | `pass123` | Learner — Sipho Khumalo |

## 🎁 Bonus: full demo dataset (hidden switch)
On the **login page**, next to "Forgot your password?", there is a **very tiny dot ( ◦ )**.
Click it → confirm → **OK loads the FULL DEMO dataset**:
- **10 learners** — `SC-2025-0001` … `SC-2025-0010` (six at Thembalethu, rest spread across schools)
- **5 facilitators** — `FAC-001` … `FAC-005` (one per school, schools 1–5)
- **1 admin** — `ADM-001`
- Extra sessions and a second marked assignment at Siyabonga Secondary, so the
  admin SLA report shows **multiple facilitators with different compliance**.

Clicking the dot and choosing **Cancel** on the second dialog **restores the starter dataset**.
(Everything runs through `POST /api/dev/reseed` — data is wiped and reseeded date-aware.)

**After switching datasets, log out and back in** — sessions issued before the switch reference the old accounts.

## Real learning content (bundled in `seed-content/`)
All materials and assignment briefs are **real PDFs**, written as actual teaching content:
- SC101: Variables & Data Types slides · Python cheat sheet · If & Loops worksheet (5 real exercises incl. FizzBuzz) · Functions notes
- SC102: HTML Structure guide · CSS guide (+ MDN link for JS)
- SC103: Staying Safe Online guide
- Briefs: A1 Python Basics · A2 Control Flow Challenge · A3 2-Page Website · A4 JS airtime calculator — each with tasks, a marks breakdown, and submission instructions.

They are copied into `uploads/` at seed time, so downloading a "slide" in the demo opens a real document.

## The seed is date-aware
Assignments sit at every lifecycle stage **on whatever day you run it**:
A1 *Returned* (fully marked, one below pass, one mark past the 7-day SLA) ·
A2 *in the marking window* (SLA countdown live, one late submission) ·
A3 *Open* · A4 *Scheduled*. Delete `social_coding.db` and restart to reseed fresh.

## The offline demo (rehearse)
1. As `FAC-001`, open **Attendance** once while online (caches the roster).
2. Airplane mode ON — **do not reload the page** (full offline page-open needs HTTPS, which comes with deployment).
3. Take the register → Save → badge shows *pending*.
4. WiFi ON → badge syncs to zero. Sync is idempotent — replays can never duplicate records.

## Deployment (next week)
See `DEPLOYMENT.md` — GitHub → Turso (free DB) → Render (free hosting) → Add to Home Screen on your phone.
