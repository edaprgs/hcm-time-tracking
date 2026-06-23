# Mini HCM Time Tracking — Build Notes & Interview Prep

**Project:** Take-home technical assessment — a lightweight HCM (Human Capital Management) Time-In/Time-Out system.
**Stack:** React (frontend) + Firebase (Auth + Firestore) + computation logic written as a pure JS module.
**Spec allowed either Node/Express or Firebase Functions for backend logic — see Decision Log for which was chosen and why.**

---

## 1. System Design — The Big Picture

### Three-layer architecture

The system is built around a deliberate separation of concerns. This is the first thing worth explaining in an interview, because it's the design decision everything else hangs off of.

| Layer | Question it answers | Where it lives |
|---|---|---|
| **Identity** | Who is this person? What's their schedule? | Firebase Auth + `users` Firestore collection |
| **Raw facts** | What happened, and when? | `attendance` Firestore collection (one doc per punch) |
| **Derived meaning** | What do those facts *mean*? (hours, OT, lateness) | `dailySummary` Firestore collection (computed) |

**Why this separation matters:** raw punches are never edited or overwritten after the fact. If the computation logic ever has a bug and gets fixed later, summaries can be recomputed from the untouched raw data. Mixing "fact" and "interpretation" together would mean a logic bug permanently corrupts the only copy of the data.

**Common mistake this avoids:** computing "lateness" at the moment of punch-in. Instead: store the punch as a plain fact, compute derived meaning as a separate step.

### Data model

**`users/{uid}`**
```js
{
  name, email, role: 'employee' | 'admin', timezone,
  schedule: { start: '09:00', end: '18:00' }
}
```

**`attendance/{autoId}`** — one document per punch event, not per day
```js
{ userId, type: 'in' | 'out', timestamp }
```

**`dailySummary/{userId}_{date}`** — one document per employee per day, computed
```js
{
  userId, date,
  regularHours, overtimeHours, nightDiffHours,
  lateMinutes, undertimeMinutes
}
```

**Why the composite key `{userId}_{date}`:** makes "update today's summary" a single deterministic write (upsert) instead of query-then-write, and makes weekly admin reports a simple date-range query.

### The computation rules (plain-English version)

- **Late** = max(0, punch-in time − scheduled start)
- **Undertime** = max(0, scheduled end − punch-out time), only if punch-out is before scheduled end
- **Regular hours** = worked time within the scheduled window, capped at shift length
- **Overtime** = worked time beyond scheduled end
- **Night Differential (ND)** = worked minutes overlapping 22:00–06:00, computed **independently** of regular/OT

**Key subtlety (commonly probed in interviews):** ND is not a separate bucket competing with regular/OT — it's an overlapping annotation. A hint of overtime that happens to fall at 11pm counts as *both* overtime *and* night differential, because ND represents a pay multiplier on hours already worked, not a different category of hours.

---

## 2. The Three Edge Cases (Designed Before Writing Code)

Reasoned through deliberately, before any code was written, to avoid naive "just subtract punch-out from punch-in" bugs.

### Edge case 1 — Missing punch-out
**Scenario:** employee punches in, never punches out (forgot, app crashed, etc.)
**Decision:** never guess the missing time. Mark the shift `incomplete: true`, compute **zero** hours for it. Lateness can still be computed (it only needs the punch-in). This surfaces the problem to an admin instead of silently fabricating a plausible-looking but false number.
**Why this matters:** prioritizes data integrity over false completeness.

### Edge case 2 — Multiple punch pairs in one day (lunch breaks)
**Scenario:** in → out (lunch) → in → out, all in one day.
**Decision:** treat all punches for a shift as an ordered sequence, pair them sequentially (`in→out, in→out...`), and **sum worked time across all pairs**.
- **Lateness** is computed only from the *first* punch-in of the day.
- **Undertime** is computed only from the *last* punch-out of the day.
- Arriving late from lunch ≠ "late." Leaving early for lunch ≠ "undertime" (as long as they finish the day).

### Edge case 3 — Overnight shifts crossing midnight
**Scenario:** schedule is 22:00–06:00. Punch in 10pm, punch out 6am the *next* calendar day.
**Decision:** a shift belongs to the calendar date it **started** on — matching real-world payroll convention ("business date" / "shift date"). This avoids the bug where an overnight shift gets split awkwardly across two `dailySummary` documents.

### Why all three resolve to one underlying principle
All three edge cases point to the same rule: **compute from the full ordered sequence of a user's punches around a shift window, not from isolated pairs treated independently.** This is worth saying explicitly in an interview — it shows the edge-case handling was one coherent model, not three unrelated patches.

---

## 3. The Computation Engine — `computeAttendance.js`

**Location:** `mini-hcm/functions/src/computeAttendance.js`

**Critical design choice:** this file is a **pure function** — zero dependency on Firebase, databases, or anything external. Input: an array of punches + a schedule. Output: a summary object. Nothing else touches the outside world.

**Why pure functions matter here (great interview line):** pure functions are trivial to unit-test in isolation. This is literally what allowed the three edge cases to be verified with a plain Node script, with no live Firestore connection required.

### What's inside it

| Function | Job |
|---|---|
| `pairPunches` | Walks a sorted punch list, matches each `in` with the next `out`. Unmatched trailing `in` → flags `incomplete`. Orphaned `out` with no preceding `in` is ignored defensively (doesn't crash). |
| `nightOverlapMinutes` | Given one worked segment, calculates how many minutes overlap the 22:00–06:00 window. Runs independently per segment — this is *why* OT and ND can coexist. |
| `computeShiftSummary` | The main function. Sorts punches → pairs them → determines shift date (anchored to first punch-in) → builds real scheduled start/end timestamps (pushing end to "tomorrow" for overnight schedules) → sums total worked minutes across segments → derives lateness, undertime, regular hours, OT, and ND. |
| `groupPunchesIntoShifts` | Helper for splitting a long multi-day punch list into separate shift buckets. **Does NOT group by calendar day first** — that would reintroduce the overnight-shift bug. A new shift only starts once the current bucket already has a complete paired sequence. |

### Test results (all 12 assertions passed)

Ran via `node test_computeAttendance.js` from inside `functions/`:

1. **Missing punch-out:** flagged `incomplete: true`, zero fabricated hours, lateness still correctly computed (5 min late).
2. **Lunch break:** 8 worked hours total (lunch gap correctly excluded), zero phantom OT, on-time arrival/departure correctly read from first/last punch.
3. **Overnight shift (22:00→06:00):** attributed to the *start* date, full 8 worked hours (not truncated at midnight), entire shift counted as ND.
4. **Bonus — day shift running late into the night:** 5h OT *and* 1h ND simultaneously — proof that ND and OT are independent, overlapping calculations, not competing buckets.
5. **Grouping helper:** correctly split two separate shifts from one combined punch list.

**Side note on timestamps:** test output showed UTC time (e.g., `...T01:05:00.000Z`) even though `09:05` local time was entered. This is just Node's default display behavior (terminal's local time is UTC+8, Philippines) — not a bug. The actual date math compared consistent local-time objects throughout, so all calculations were correct. Flagged as something to handle *deliberately* once real users in different timezones are involved (their `timezone` field, stored per the original spec, will matter then).

---

## 4. Decision Log

These are the deliberate choices made along the way — useful to have ready if asked "why did you do it this way?"

| Decision | Reasoning |
|---|---|
| **Pure function for computation logic** | Testable in isolation, no Firebase mocking needed, reusable regardless of where it's invoked from. |
| **Separate raw facts (`attendance`) from derived meaning (`dailySummary`)** | Bugs in computation logic don't corrupt the only copy of the data; summaries can be recomputed from source. |
| **Composite key `{userId}_{date}` for summaries** | Deterministic upsert instead of query-then-write; simple range queries for weekly admin reports. |
| **Shift "owns" the date it started on (not the date each punch falls on)** | Matches real payroll convention; avoids splitting overnight shifts across two summary docs. |
| **Incomplete shifts get zero computed hours, not a guess** | Data integrity over false completeness — surfaces problems to admins instead of hiding them. |
| **ND computed independently of OT/regular, not subtracted from them** | ND is a pay-multiplier annotation on worked time, not a separate bucket of hours. |
| **Initially planned: Firebase Functions (Cloud Functions) for server-side computation** | Originally chosen over Node/Express because the project already needed Firebase for Auth + Firestore — avoids a second hosted service and CORS configuration between two separately-hosted things; Firestore triggers map naturally to "recompute on punch write." |
| **Reversed: compute client-side from React instead of deploying Cloud Functions** | Cloud Functions deployment (any generation) requires the Firebase **Blaze** (pay-as-you-go) billing plan — Firestore/Auth themselves stay free on Spark, but deploying *any* Cloud Function does not. To avoid attaching a billing card for a take-home test, computation was moved to run client-side in React using the Firebase **client SDK**, calling the same untouched `computeShiftSummary` pure function. The spec explicitly allows either Node/Express *or* Firebase Functions — nothing requires server-side triggers specifically, so this is a legitimate, explainable scope decision. The original Firestore trigger code (`index.js`) was kept in the project, unused, as a demonstration of Cloud Functions knowledge and an interview talking point. |
| **Firestore security rules: ownership-based access, not open/test-mode rules** | Firestore was initialized in production mode (locked down by default) rather than test mode (wide open) as a deliberate security choice. Rules check `request.auth.uid` against the document's owner field, with a separate `isAdmin()` helper that looks up the requester's own role. A user can self-register and edit their own profile, but cannot change their own `role` field — that requires admin access — preventing self-promotion via a normal profile edit. |
| **Self-registration always defaults to `role: 'employee'`; admin role assigned manually via Firestore console** | Role assignment is realistically an HR/admin action, not something a self-service signup form should expose. Building a role-assignment UI wasn't asked for in the spec, so this was scoped out deliberately rather than overbuilt. |
| **Registration schedule hardcoded to 09:00–18:00, not user-editable at signup** | Schedule assignment is realistically an admin/HR action in a real HCM system, not something a new employee self-selects. Keeps the registration form focused on identity only. |

---

## 5. Firebase Project Setup (Console + CLI)

### Console setup
1. Created project at console.firebase.google.com (`mini-hcm-edagraceparagoso`).
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database → Production mode** (not test mode — starts locked down, security rules written explicitly rather than left wide open).

### Local environment setup
1. `npm install firebase-admin firebase-functions` inside `functions/` — libraries the *code* imports. `firebase-admin` = privileged server-side Firestore access; `firebase-functions` = trigger syntax.
2. `npm install -g firebase-tools` — the CLI tool itself (separate from the libraries above). Hit a macOS `EACCES` permissions error on first attempt (user account didn't own the system folder npm tried to write to). Fixed by redirecting global npm installs to a personal folder (`~/.npm-global`) and adding it to the shell's `PATH` via `.zshrc`, instead of using `sudo` (which risks root-owned files creating future permission conflicts).
3. `firebase login` — authenticated the CLI with Google account.
4. `firebase init` — wizard that wires the local folder to the Firebase project:
   - Selected **Firestore + Functions + Hosting.**
   - Linked to the existing project (not "create new").
   - Generated `firestore.rules` and `firestore.indexes.json` (rules still need to be written for real).
   - Chose **JavaScript** (not TypeScript) for Functions — matches existing code.
   - Declined ESLint, GitHub auto-deploy, and Firebase's AI agent skills (unnecessary complexity for a 1-week test).
   - **Said "No" to overwriting `functions/package.json`** — preserved already-installed dependencies.
   - `web/build` set as Hosting public directory (placeholder for the eventual React production build).

### Project folder structure (as of this point)
```
mini-hcm/
├── functions/
│   ├── src/
│   │   └── computeAttendance.js     ✅ built + tested (pure function)
│   ├── index.js                      ✅ written (Firestore trigger) — NOT deployed, kept as reference
│   ├── test_computeAttendance.js     ✅ test script, all 12 assertions pass
│   ├── package.json
│   └── node_modules/
├── firestore.rules                   🔲 still default, needs real rules
├── firestore.indexes.json
├── .firebaserc / firebase.json
└── web/                               🔲 React app — not started
    └── build/                         (placeholder for production build)
```

---

## 6. The Firestore Trigger — `index.js` (Written, Not Deployed)

**Status:** fully written and explainable, but **not deployed** — see Decision Log above for why (Blaze billing requirement). Kept in the project as evidence of Cloud Functions knowledge.

### What it does, conceptually
Listens for any write (create/update/delete) on the `attendance` collection. When triggered:
1. Reads the punch that caused the trigger.
2. Looks up that user's schedule from `users`.
3. Fetches a **36-hour window** of that user's punches centered on the triggering punch.
4. Hands that window to `computeShiftSummary` (the same tested pure function).
5. Writes the result into `dailySummary/{userId}_{date}` using `.set(..., { merge: true })`.

### Why these specific choices

| Choice | Reasoning |
|---|---|
| **`onDocumentWritten` (not `onDocumentCreated`)** | Fires on create, update, *and* delete. Needed because the spec requires admins to edit/delete punches — those changes must also trigger recomputation, not just the original punch-in. |
| **36-hour fetch window (not "today's punches")** | Directly defends overnight-shift handling. Querying by "today" would miss an overnight shift's punch-out (which lands on the next calendar day) — exactly the bug the system was designed to avoid. The window's job is just "guarantee the computation function has enough raw data"; the precise pairing/date-attribution logic is left entirely to the already-tested `computeShiftSummary`. |
| **`{ merge: true }` on the Firestore write** | Without it, `.set()` replaces the *entire* document, wiping out any fields not included in that write — e.g., an admin's manually added `adminNote` or `approved: true` field would get silently deleted on the next automatic recompute. `merge: true` only updates the specified fields. |

### Why it was never deployed
Cloud Functions deployment (1st or 2nd gen) requires the Firebase **Blaze** plan, which requires a linked billing method — even though actual usage for a project this size would stay within Blaze's free quota. To avoid attaching a card for a take-home test, computation was moved to run client-side from React instead (see Decision Log). The trigger code itself remains correct and deployable — it just isn't currently live.

---

## 8. Glossary (Quick Reference for Interview)

- **HCM:** Human Capital Management — broad term for systems managing employee data, time, payroll, etc.
- **OT (Overtime):** worked time beyond the scheduled shift length.
- **ND (Night Differential):** premium pay for hours worked between 22:00–06:00; independent of OT/regular classification.
- **Pure function:** a function with no side effects and no dependency on external state — same input always produces same output. Used deliberately for `computeAttendance.js` to keep it testable.
- **Firestore trigger:** server-side code that runs automatically in response to a database write, without polling or manual invocation.
- **Spark vs. Blaze (Firebase billing plans):** Spark = free tier, no card required, but cannot deploy Cloud Functions. Blaze = pay-as-you-go, requires a linked billing method, required for any Cloud Functions deployment (even if usage stays within free quota).
- **`{ merge: true }`:** a Firestore write option that updates only the specified fields on a document instead of replacing the whole document.

---

## 8a. Debugging Story Worth Remembering — Registration Failure

**What happened:** first registration attempt showed the error "Your account was created, but setting up your profile failed." Testing again with the *same* email produced a different-looking error: a `400 Bad Request` on `accounts:signUp`.

**The debugging process (good interview material):**
1. Initially assumed both errors were the same root cause (missing Firestore rules).
2. Checked the Network tab response body for the second error and found `EMAIL_EXISTS` — this revealed the second test was actually hitting a *different* problem (reusing an already-registered email), not the same one.
3. This clarified that the **first** error was the real bug to chase: Step 1 (Auth) had actually succeeded the first time (confirmed by checking the Authentication → Users list in console), so the failure was specifically in Step 2 (the Firestore profile write).
4. Root cause: Firestore was initialized in **production mode**, which locks down all reads/writes by default until explicit security rules are written. No rules had been deployed yet, so Firestore correctly rejected the write.
5. Fix: wrote and deployed `firestore.rules` defining ownership-based access (a user can read/write their own `users/{uid}` doc; admins can read/write anyone's). Also added a field-level restriction preventing a user from changing their own `role` during a self-edit, so a normal profile update can't be used to self-promote to admin.
6. Deleted the orphaned half-registered Auth account (existed in Auth, no matching Firestore profile) before retesting with a fresh email.
7. Retested — full chain (Auth account creation → Firestore profile write) succeeded; verified all fields landed correctly in the console.

**Why this is worth retelling in an interview:** it demonstrates reading error messages precisely rather than assuming — two errors that looked similar on the surface (`400` responses, vague-sounding messages) actually came from two different services (`identitytoolkit.googleapis.com` = Auth, vs. a Firestore permission rejection) and had two different causes. Distinguishing them required checking the Network tab's actual response body rather than guessing from the console output alone.

---

## 8b. Debugging Pattern Worth Remembering — Composite Indexes

Hit the same Firestore error shape **three separate times** while building the Punch Clock and Dashboard screens:

1. `attendance` query: `where userId ==` + `orderBy timestamp desc` (finding the latest punch to derive clock-in/out status)
2. `attendance` query: `where userId ==` + `where timestamp >=` + `where timestamp <=` + `orderBy timestamp asc` (the 36-hour recompute window)
3. `dailySummary` query: `where userId ==` + `where date >=` + `where date <=` + `orderBy date desc` (the Dashboard's 7-day history)

**The pattern:** any time a Firestore query combines an equality filter (`where(x, '==', ...)`) with a range filter or `orderBy` on a *different* field, Firestore requires a composite index — it will not guess how to optimize that combination automatically. The error message conveniently includes a direct link that pre-fills the exact index needed in the console; clicking it, confirming the fields, and waiting 1–5 minutes for it to build is the fix every time.

**Why Firestore works this way (good interview answer if asked):** composite indexes are what let Firestore answer these queries quickly at scale — without one, it would have to scan and sort the entire collection on every request. Requiring developers to explicitly create them forces deliberate thinking about query performance upfront, rather than allowing performance to silently degrade as data grows.

**A separate, real rules bug found while testing this:** the `dailySummary` create rule originally checked `resource.data.userId`, but on a brand-new document (first-ever punch-out of the day), no existing document exists yet, so `resource.data` is `null` and the check fails. Fixed by checking `request.resource.data.userId` (the incoming data) specifically for the `create` case, while keeping `resource.data.userId` (existing data) for `read`/`update`. This is the `request.resource` vs `resource` distinction in practice — a real example of the exact subtlety flagged earlier as a common rules bug source.

---

## 8c. Punch Clock & Dashboard — What Was Built

**`PunchClock.jsx`** (route: `/punch`) — the core daily-use screen.
- Status (clocked in vs. out) is **derived**, never stored as its own field — read from the most recent `attendance` document's `type`. Keeps `attendance` the single source of truth.
- Button disabled while a punch is in-flight, preventing double-clicks from firing two punches in quick succession (which would corrupt the in/out pairing sequence).
- After a punch, calls `recomputeAroundNow` (client-side replacement for the undeployed Cloud Functions trigger) to immediately recompute and display today's summary.

**`Dashboard.jsx`** (route: `/dashboard`) — the history view, satisfying the spec's "Display results in React (Dashboard + History table)" requirement.
- Fetches the last 7 days of `dailySummary` documents in one range query.
- KPI strip (total regular/OT/ND/late/undertime) is aggregated client-side from the same data already fetched — no second query needed.
- History table shows one row per day with full breakdown + a Complete/Incomplete status column.

**`attendanceService.js`** — the data-access layer separating Firestore query logic from UI components: `getLatestPunch`, `recordPunch`, `recomputeAroundNow`, `getSummaryHistory`.

**Note on code duplication:** `computeAttendance.js` exists in two places — `functions/src/` (original, tested) and `web/src/services/` (copy, used by the React app since computation runs client-side). This is a deliberate, explainable tradeoff: sharing one file cleanly across two separate Node/build environments would require monorepo tooling, not worth the complexity for one small pure-function file in a 1-week assessment.

---

## 8d. Admin Tools — What Was Built

**`AdminDashboard.jsx`** (route: `/admin`) — gated to admins only, two-layer enforcement:
- **UI layer:** checks the logged-in user's `role` after their profile loads; non-admins are redirected to `/punch`. Waits for the profile fetch to fully resolve before deciding — avoids a flash-redirect for real admins while their role is still loading.
- **Data layer (the real enforcement):** Firestore rules' `isAdmin()` check already permits cross-user reads/writes — the UI gate is a UX nicety, not actual security. Worth stating explicitly: if the UI check were ever bypassed, Firestore would still correctly reject unauthorized access.

**Three sub-features, one screen:**
1. **Employee Punches** — picker (all users via `getAllUsers()`) → punch list for selected user (`getPunchesForUser()`) → inline edit (flip in/out type) and delete, each followed by a recompute of the affected day's summary.
2. **Daily Report** — all employees' `dailySummary` for one chosen date (`getDailyReportForAllUsers()`).
3. **Weekly Report** — all employees' summaries aggregated client-side across a 7-day range (`getWeeklyReportForAllUsers()`) — aggregation happens in JS, not Firestore, since cross-document sums aren't a native Firestore capability without Cloud Functions (consistent with the earlier decision to stay client-side only).

**New service functions added to `attendanceService.js`:** `getAllUsers`, `getPunchesForUser`, `updatePunch`, `deletePunch`, `getDailyReportForAllUsers`, `getWeeklyReportForAllUsers`, plus a refactor of the original `recomputeAroundNow` into a more general `recomputeAroundTime(userId, schedule, centerTime)` — see the bug below for why this refactor was necessary, not just nice-to-have.

---

## 8e. Real Bugs Found While Building Admin Tools (Strong Interview Material)

### Bug 1 — Recompute window centered on "now" instead of the edited punch's date
**Found during design review, before it caused a live failure.** The original `recomputeAroundNow` always centered its 36-hour fetch window on the current moment. That's correct for the Punch Clock (you're always acting on "right now"), but wrong for admin edits to **older** punches — editing a 3-day-old punch would recompute a window centered on today, missing the actual shift being edited entirely.
**Fix:** refactored into `recomputeAroundTime(userId, schedule, centerTime)`, which accepts an explicit center timestamp. Admin edit/delete functions now pass the punch's **original** timestamp (captured before the edit) as that center. `updatePunch` additionally recomputes a second time centered on the *new* timestamp if the edit changed which day the punch falls on, so both the old and new day's summaries end up correct.
**Why this is worth mentioning in an interview:** found by reasoning through the design before writing the admin UI, not by hitting a crash first — a good example of anticipating a class of bug rather than only reacting to one.

### Bug 2 — Crash on zero valid punch segments (`Cannot read properties of undefined (reading 'in')`)
**Found live, while testing the admin "flip type" button.** Flipping a punch's type (e.g. changing the *first* chronological punch from `in` to `out`) can produce a punch sequence where the only punches in the window are orphaned `out`s with no preceding `in`. `pairPunches` correctly drops orphaned `out`s per its original design — but that meant `segments` could end up completely empty. `computeShiftSummary` then unconditionally read `segments[0].in` to determine lateness, which crashed when `segments` was `[]`.
**Fix:** added an explicit guard — if `segments.length === 0`, return a clean "incomplete, zero hours" result immediately instead of proceeding into code that assumes at least one segment exists. Applied identically to both copies of `computeAttendance.js` (functions/ and web/) to keep them in sync, and re-ran the original 12-assertion test suite to confirm the fix was purely additive (all original tests still passed).
**Why this is worth mentioning in an interview:** demonstrates the value of having a pure, tested function — the bug was reproduced and fixed in isolation with a two-line Node script, confirmed against the existing test suite, *before* touching the real app again. Also a good prompt to explain: edge cases aren't only found by thinking ahead (see Day 1's three designed cases) — some only surface once a feature like admin editing creates input shapes the original design didn't anticipate. Good engineering practice is noticing *and fixing* these as they appear, not just the ones you predicted upfront.

### Bug 3 — Logout appeared to "do nothing"
**Found during final testing.** `signOut(auth)` was actually working correctly the whole time — confirmed by manually navigating to `/login` after clicking it, which showed the login form as expected. The real issue: none of the three main pages (`PunchClock`, `Dashboard`, `AdminDashboard`) had any logic reacting to the user becoming logged out — they only set `user` state when a user exists, so after logout they were stuck waiting forever on an `onAuthStateChanged` callback that legitimately fired with `null`, with no redirect attached to that case.
**Fix:** added an `authChecked` boolean (distinct from "is there a user") to each page's auth listener, and a guard clause — `if (authChecked && !user) return <Navigate to="/login" replace />` — so each page now correctly redirects once auth resolves to "nobody," instead of showing "Loading..." indefinitely.
**Why this is worth mentioning in an interview:** a good example of distinguishing "the feature itself is broken" from "the feature works, but nothing downstream reacts to its result" — verifying the actual mechanism (try the URL directly) before assuming where the bug lives.

### Minor UX gap, deliberately scoped out — Login doesn't redirect by role
Originally, `Login.jsx` always navigated to `/punch` regardless of role, requiring admins to manually navigate to `/admin` after logging in. Given the spec doesn't require role-based landing pages — only that admin capabilities exist and are reachable — this was initially left as a known, explainable scope note under time pressure, then fixed last-minute by adding a post-login Firestore role check (`navigate(role === 'admin' ? '/admin' : '/punch')`), wrapped in its own try/catch so a failed role lookup never blocks a successful login.

---

## 8f. Styling Pass

A single `App.css` file was written covering every class name already used across components (`auth-page`, `punch-button`, `kpi-card`, `history-table`, `admin-section`, etc.) — **zero JSX changes required**, since components already referenced these class names from the start; only the empty default CRA stylesheet needed real content. This kept the styling pass low-risk under deadline pressure: pure visual layer, no chance of breaking already-tested logic.

---

## 9. Final Pre-Submission Checklist

1. Register a new account → lands on `/punch`, Firestore profile fields correct.
2. Login as employee → `/punch`. Login as admin → `/admin` (role-based redirect).
3. Punch In/Out → status flips, summary appears, numbers sane.
4. Logout from any page → redirects cleanly to `/login`.
5. Dashboard → KPI strip + history table populated.
6. Admin → Employee Punches: pick user, view/flip/delete punches, no console errors.
7. Admin → Daily Report: pick date, load, see row(s).
8. Admin → Weekly Report: load, see aggregated totals.
9. Non-admin visiting `/admin` directly → redirected to `/punch`.

---

## 10. Closing Summary

Every functional requirement from the original assessment spec is implemented:
- Registration & Authentication (Firebase Auth + Firestore profile with schedule)
- Time-In/Time-Out logging (React punch UI → `attendance` collection)
- Computation of regular hours, OT, ND, late, undertime — including three deliberately-designed edge cases (missing punch-out, lunch breaks, overnight shifts crossing midnight)
- Daily Summary (dashboard + history table with full breakdown)
- Admin Tools (view/edit/delete punches, daily reports, weekly reports across all employees)

Key architectural decisions, all explainable and defensible (full detail in Section 4's Decision Log):
- Pure-function computation engine, tested in isolation, duplicated (not shared) across two separate Node environments
- Client-side computation instead of deployed Cloud Functions, to avoid requiring Firebase's Blaze billing plan for a take-home assessment
- Firestore production-mode security rules with ownership + role-based access, including a field-level restriction preventing self-promotion to admin
- Derived (not stored) clock-in/out status, keeping `attendance` the single source of truth

Real bugs encountered and fixed during the build (Sections 7b, 7c, 7f) are themselves good interview material — they demonstrate methodical debugging (distinguishing error sources, reproducing bugs in isolation before fixing, verifying fixes against existing tests) rather than only describing a system that worked perfectly on the first try.
