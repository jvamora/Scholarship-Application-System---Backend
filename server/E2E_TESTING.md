# E2E Test Harness — EduGrant Scholarship Portal

Self-contained end-to-end suite that boots the real Express app on port 51996,
drives every role's journey against the **live Supabase database** — including
awarding the scholar — then cleans up after itself.

## Run

```bash
cd server
node _purge.js     # remove leftover test artifacts (safe: targets @test.local only)
node _run.js       # 96 checks; writes _run_result.json + _run_log.txt (+ _run_out/_run_err)
node _dbcheck.js   # verify the DB is clean afterwards (all zeros + "DB CLEAN")
```

`_run.js` exits `0` when every check passes, `1` otherwise.

## Coverage (96 checks)

| Area | What's exercised |
|---|---|
| Auth | staff-only self-register (committee/applicant/admin rejected), temp-password login, first-login activation, `GET /me`, profile update, change-password (+ re-login), logout + token revocation |
| Staff | create/list/edit applicants, reset applicant password, delete pending applicant, applicants' applications view, notifications |
| Admin | pending list, approve/reject, create user, role change (+ `admin` guard), suspend/reactivate, reset password, bulk approve, update user, audit logs, notifications |
| Scholarships | create (open + draft), edit, detail, draft hidden from public, delete |
| Applications | submit with document upload, duplicate guard (409), list/detail, document download, notifications + mark-read |
| Committee | login, pending-count, review queue (+ status filter), application detail (history aggregated), applicant list + detail, reviews (approve/waitlist) with quorum, notifications + mark-read |
| Selection & awards | run selection (shortlist), leaderboard, approve-awardees, program close + slots consumed, accept-award (wrong signature → 400, correct → `scholar_active` + scholars row), decline-award → waitlist promotion, manual promote-waitlist, slot invariants at every step |
| Reports | scholarship/application/user stats, status distribution, timeline, both CSV exports |
| Search | scholarship search + filters, committee application search, save/get preferences |

**Excluded by design:** the `interview` status (not part of the committee decision flow).

## App bugs found & fixed during E2E verification

1. **`src/controllers/reportController.js`** — `getApplicationTimeline` used MySQL
   `DATE_SUB(NOW(), INTERVAL 30 DAY)` / `DATE(col)`; on PostgreSQL this 500'd.
   Now `NOW() - INTERVAL '30 days'` + `submitted_at::date`.
2. **`is_read = 1` → `is_read = TRUE`** (PostgreSQL boolean) in
   `src/controllers/applicationController.js`, `adminController.js`,
   `staffController.js` and `src/routes/committeeRoutes.js` — the applicant/admin/
   staff/committee "mark notification read" endpoints all 500'd.
3. **`src/models/userModel.js` `User.update`** — forced `email = NULL` on partial
   updates (the admin profile edit sends only `first_name`/`last_name`), violating
   the NOT NULL constraint (500). Now builds the `SET` clause only from the fields
   actually provided.
4. **`src/routes/applicationRoutes.js` `wrapAwardAction`** — intentional
   `SelectionError`s (wrong signature, award already accepted, …) were re-thrown
   into the global handler and logged a full stack trace. Now answered directly
   with their status/message (still 400/409); unexpected errors still escalate.

## Notes

- Emails are deterministic per run (`r<timestamp>_<tag>@test.local`), so runs are
  reproducible and never collide with each other or with real accounts.
- The harness removes its own artifacts; `_purge.js` is a belt-and-braces
  pre-clean for interrupted runs, and `_dbcheck.js` proves the DB afterwards.
- `_run_err.log` should be empty on a green run.
