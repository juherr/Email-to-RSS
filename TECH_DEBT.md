# Tech Debt — Remediation Plan

Generated: 2026-05-22

## Scoring: Priority = (Impact + Risk) × (6 − Effort)

---

## Phase 1 — This sprint (quick wins, high ROI)

| #     | Task                                                         | Priority | Status |
| ----- | ------------------------------------------------------------ | -------- | ------ |
| P0-2  | Add `inbound.test.ts` with full coverage                     | 40       | DONE   |
| P0-1  | Document race condition + TODO for Durable Objects migration | 36       | DONE   |
| P2-9  | Fix orphaned KV key deletion in `storage.ts` feed trim       | 18       | DONE   |
| P2-12 | Add `/health` endpoint                                       | 15       | DONE   |

## Phase 2 — Next milestone (3–5 days)

| #     | Task                                                        | Priority | Status |
| ----- | ----------------------------------------------------------- | -------- | ------ |
| P1-7  | Add `entries.test.ts`, `files.test.ts`, hub lifecycle tests | 32       | DONE   |
| P1-3  | Extract shared RSS/Atom feed-fetching logic                 | 21       | DONE   |
| P1-6  | Split `email-processor.ts` responsibilities                 | 21       | DONE   |
| P2-8  | Add CSRF token to admin forms                               | 21       | DONE   |
| P3-13 | Fix `Hono<{ Bindings: Env }>` type safety                   | 8        | DONE   |

## Phase 3 — Ongoing / Infrastructure

| #     | Task                                                 | Priority | Status                    |
| ----- | ---------------------------------------------------- | -------- | ------------------------- |
| P1-4  | Structured logging + error aggregation               | 36       | DONE                      |
| P1-5  | Rate limiting (Cloudflare WAF rules)                 | 24       | Infrastructure (see TODO) |
| P2-10 | Extract constants module (`src/config/constants.ts`) | 12       | DONE                      |
| P2-11 | Split `admin.ts` into sub-modules                    | 8        | DONE                      |

---

## Top 3 Business Risks

1. **Data loss** — concurrent email ingest silently drops emails (KV race condition)
2. **Undetected regressions** — inbound route has zero tests; any change is a gamble
3. **Silent failures** — no error tracking means production issues are invisible

---

## Detailed Findings

### Critical

**Race condition in KV metadata updates** (`src/lib/email-processor.ts`)
Two concurrent emails to the same feed read-modify-write the metadata non-atomically.
The second writer silently overwrites the first's changes. Accepted limitation of KV;
see TODO.md for the Durable Objects migration roadmap item.

**Email ingest path has zero tests** (`src/routes/inbound.ts`)
The most critical path in the system is entirely unguarded. Required: happy path,
invalid IPs, missing fields, KV write failure, sender validation, attachment upload.

### High

**Duplicated RSS/Atom route logic** (`src/routes/rss.ts`, `src/routes/atom.ts`)
Param extraction, feedId validation, KV fetches, pagination, cache headers and Link
header building are duplicated verbatim. Fix: extract `fetchFeedAndEmails()` utility.

**No error tracking or production alerting**
All errors are console-only, invisible in production. Fix: structured JSON logging

- Cloudflare Logpush or Sentry integration.

**No rate limiting on `/api/inbound` or `/admin` login**
IP validation is insufficient; admin login has no brute-force protection.
Fix: Cloudflare WAF rate-limiting rules.

**`email-processor.ts` violates single responsibility**
Feed ID extraction, sender validation, attachment upload, KV write, feed trimming,
and WebSub notification in one function. Fix: split into `validateEmail()`, `storeEmail()`.

### Medium

**No CSRF protection on admin forms** (`src/routes/admin.ts`)
State-changing POSTs have no CSRF token. Fix: generate token on page load, validate on POST.

**Orphaned KV keys in `storage.ts` feed trim**
`updateFeedMetadata()` truncates the metadata list but never deletes the actual KV entries.
(Note: `email-processor.ts` already handles this correctly in the live code path.)

**Magic numbers without constants**
Limits scattered as inline literals: 20 items, 50 metadata, 512 KB, 24h TTL, 30-day lease.
Fix: extract to `src/config/constants.ts`.

**No `/health` endpoint**
Monitoring tools cannot detect a bad deploy. Fix: `GET /health` returning `{ status: "ok" }`.

### Low

**`as unknown as Env` type cast** (`src/index.ts` line 7)
Bypasses TypeScript; Env mismatches become runtime errors.

**Inconsistent utility organisation** (`lib/` vs `utils/`)
No clear rule for placement of new utilities.

**No audit log for admin actions**
Create/delete feed, bulk-delete emails — no record of who did what.
