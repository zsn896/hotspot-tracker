# Hot Spot tracker

A dashboard that collects twelve hours of California Lottery Hot Spot draws, searches for five-number groups that repeat, and then reports whether those groups actually beat the odds.

In a fair game they will not, and saying so clearly is the point of the project. Hot Spot draws 20 numbers from 80 every four minutes, independently each time. No pattern in past draws changes what the next draw does. This is a measurement tool, not a betting system.

---

## What it measures

The chance model is exactly known, so every number on the dashboard has a reference value to sit beside:

| Quantity | Exact value |
| --- | --- |
| A specific 5-number group appears in full in one draw | `C(20,5) / C(80,5)` = 1 in 1,551 |
| Hits per draw for a 5-number group | 1.25 on average |
| Distribution of hits (0–5) | Hypergeometric: 0.2272, 0.4057, 0.2705, 0.0839, 0.0121, 0.00065 |
| Bulls-eye falls inside a 5-number group | 5/80 = 6.25% |
| Times each number should appear over 180 draws | 45 |

Three things are reported against those values:

- **The board.** All 80 numbers, shaded by how often each came up. An even wash is the headline finding.
- **The selection.** How many candidate groups were searched, how many repeated out of sample, and how many a fair game would be expected to produce at each level. Because expectation is linear, that comparison is exact even though the candidates overlap heavily.
- **The tracking.** Observed hit distribution against the hypergeometric reference, with a chi-square goodness-of-fit test, a z-test on mean hits, and Wilson intervals on the hit rates.

### How groups are selected

Candidates are mined from the **first half** of the window and scored **only on the second half**.

This is not a detail. Every candidate is, by construction, a subset shared by the pair of draws that generated it, so it always has at least two hits in the data it came from. Ranking candidates by their frequency over that same window is circular reasoning, and under a random-input control it flagged a "hot" group in 14 of 15 runs — it fired almost every time on data with nothing in it.

Scoring on unseen draws fixes that. The p-value is an exact binomial tail, corrected for the size of the search with both Bonferroni and Benjamini–Hochberg. `npm run simulate` re-runs the control experiment:

```
falsePositiveRateBonferroni: "2.5%"     (alpha = 5%)
observedOverExpectedCandidates: 1.016   (sd 0.075)
verdict: "PASS — the selector does not manufacture significance on random input"
```

A companion test plants a real signal in synthetic draws and confirms the selector still finds it, so the correction is not simply switched off.

---

## Setup

**1. Database.** Create a Supabase project and run [`schema.sql`](schema.sql) in the SQL editor. The unique constraints there are required — the upserts depend on them.

**2. Environment.** Copy `.env.example` and fill in:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key. Server-side only; never expose it to the browser. |
| `WORKER_SECRET` | recommended | Guards `/api/worker` and `/api/track`, both of which reach out to the lottery site on every call. Without it, either endpoint is a free amplifier pointed at someone else's servers. |

**3. Deploy.** `vercel deploy`. No build step and no dependencies to install.

**4. Schedule the worker.** This is the step that is easy to get wrong.

`/api/worker` must run **every few minutes**, not once a day. It collects draws incrementally: each invocation fetches what it can inside its time budget, commits the progress, and picks up where it left off. `vercel.json` requests `*/5 * * * *`, but **Vercel's Hobby plan only permits one cron per day**. On Hobby, point an external scheduler at the endpoint instead:

```
*/5 * * * *  curl -fsS "https://your-app.vercel.app/api/worker?secret=YOUR_SECRET"
```

cron-job.org, GitHub Actions, Upstash QStash, or any always-on box will do. If nothing calls the worker, the dashboard will say so rather than sitting on an empty screen — `/api/state` only reads data and cannot start collection itself.

Check `/api/health` to confirm which variables the deployment actually sees.

---

## The daily cycle

All times are `America/Los_Angeles`.

| Window | Phase | What happens |
| --- | --- | --- |
| 06:00 – 18:00 | collecting | 180 draws are scraped and stored |
| 18:00 | selection | candidates are mined and scored; two groups are chosen |
| 18:00 – 02:00 | tracking | each new draw is scored against both groups, in six 20-draw blocks |
| 02:00 – 02:30 | idle | tracking has finished |
| 02:30 – 06:00 | cleanup | the cycle's data is deleted |

---

## Endpoints

| Route | Auth | Description |
| --- | --- | --- |
| `GET /api/state` | none | Everything the dashboard renders. Read-only. |
| `GET /api/worker` | secret | Advances the cycle. Safe to call repeatedly; it is idempotent and takes a lock. |
| `GET /api/health` | none | Liveness and configuration. Reports whether secrets are *set*, never their values. |
| `GET /api/track` | secret | Ad-hoc scoring of arbitrary groups against recent draws. `?groups=1,2,3,4,5;6,7,8,9,10` |
| `GET /api/group` | none | Returns 409. Groups cannot be set by hand in this build. |

---

## Layout

```
index.html          dashboard (English/Arabic, no framework)
schema.sql          database definition
lib/
  config.js         every tunable, in one place
  time.js           California clock, cycle boundaries, schedule phases
  stats.js          hypergeometric, exact binomial tails, chi-square, Wilson, Bonferroni, BH
  analysis.js       candidate mining, out-of-sample selection, gap stats, performance evaluation
  lottery.js        scraper and parser
  http.js           time budget, concurrency limit, retry with backoff
  db.js             Supabase access, batched writes, advisory lock
  validate.js       input normalisation
api/                state, worker, track, group, health
test/               51 unit and integration tests, plus the Monte Carlo control
```

`lib/stats.js` and `lib/analysis.js` are pure: no I/O, no globals, no dependencies. That is what makes the statistics testable against published critical values.

## Tests

```bash
npm test        # 51 unit + integration tests
npm run simulate # Monte Carlo false-positive control
npm run check   # both
```

The integration test runs `api/worker.js` and `api/state.js` unmodified against an in-memory PostgREST emulator, a fake lottery source, and a frozen clock. It exercises scraping, parsing, batching, locking, selection, scoring, block reporting, idempotence, and the JSON contract the dashboard consumes. No network or database is needed.

---

## What changed from version 2

**Correctness**

- The parser took the first 20 integers on the page and de-duplicated them, so one stray number (a `12 of 20` label, a payout figure) silently dropped the draw. Extraction now works over maximal ascending runs, disambiguated by the Bulls-eye, which is guaranteed to be one of the 20 drawn numbers. Verified against 401 adversarial fixture pages.
- The collection window's start was inferred from the latest draw with no sanity check. A lagging source could anchor an entire day's data hundreds of draws off. Anchors outside the 06:00–02:00 draw window are now refused.
- A failed fetch on one draw aborted the whole batch. Failures are now isolated and reported, and the cursor only advances across a contiguous run so a transient error cannot leave a permanent hole.
- Two overlapping worker runs — a cron tick and a manual refresh — double-fetched every draw and raced on `last_seen_draw_id`. An advisory lock prevents it.
- p-values used a Poisson approximation; they are now exact binomial.
- Gap standard deviation used the population formula, which reports zero spread for a single observation. It is now the sample deviation, and the projected window can no longer be falsely narrow.

**Performance**

- Backfilling 80 draws made 80 sequential writes to Supabase. Writes are now batched.
- Candidate counting was ~15 million set lookups per selection. A bitset index reduced it to a handful of ANDs and popcounts per candidate: **117 ms → 35 ms**, with correctness verified against brute force.
- `/api/state` ran two queries per group; draw metadata is now resolved in one query for all groups.
- `cheerio` (a full HTML parser, pulled in to read plain text) was removed. The project now has **zero runtime dependencies** and a faster cold start.

**Robustness**

- No fetch timeout existed, so one stalled connection could consume the entire function duration. Every request now has an `AbortController` timeout, capped exponential backoff with full jitter, and `Retry-After` support.
- The worker had no notion of its own deadline and could be killed mid-backfill, losing everything it had fetched. Work is now committed in chunks against a wall-clock budget.
- `WORKER_SECRET` was compared with `!==`; it now uses a constant-time comparison. `/api/track` was unauthenticated despite hitting the lottery site up to 80 times per call.
- `schema.sql` did not exist. The constraints the upserts depend on had to be guessed.

**Analysis and presentation**

- The p-value, candidate count, and significance verdict were computed but never shown. The dashboard now leads with them.
- Added the chance benchmark, the observed-vs-expected hit distribution, chi-square goodness of fit, and Wilson intervals — so "this is what chance looks like" is a number on screen, not a disclaimer under it.
- The dashboard was rebuilt around the 80-number board and now reads in English or Arabic.
