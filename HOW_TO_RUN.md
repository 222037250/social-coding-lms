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

## The dataset you get by default
Starting the server on a fresh database loads the **full dataset automatically** —
no hidden switches, nothing to click:

| | |
|---|---|
| Schools | **10**, every one staffed, funded and delivering sessions |
| Learners | **180** — 142 studying, 30 completed (2024), 8 withdrawn (18 per school) |
| Facilitators | **10** — `FAC-001` … `FAC-010`, one per school |
| Sessions | ~146 with **~2 600 attendance records** |
| Assignments | 55 across 5 modules — every lifecycle state at every school |
| Submissions / marks | ~770 submissions, ~450 marks (some late, some past the SLA) |
| Sponsors | 8 organisations funding all 10 schools |
| Early warning | ~36 learners flagged, at least one at **every** school |

### Seeing only one active school?
You have an older, smaller database file from a previous version. Stop the server,
delete **`social_coding.db`**, and start it again — it will reseed with everything.

### Logins (password `pass123`, except the admin)
- Admin: `ADM-001` / `admin123`
- Facilitators: `FAC-001` … `FAC-010` (each sees their own school)
- Learners: `SC-2025-0001`, `SC-2025-0002`, then `SC-2025-0101` upward
- Completed alumni: `SC-2024-0012`, `SC-2024-0018` and others in the 01xx range

### Small dataset for quick testing
The tiny dot ( ◦ ) next to "Forgot your password?" on the login page swaps datasets:
**OK** reloads the full dataset, **Cancel** loads a small starter set (1 school,
2 learners) if you want something minimal. Log out and back in after switching.

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
