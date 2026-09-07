# Wiring the ledger into the existing cron

Three edits. Nothing in the precursor engine changes.

## 1. Database

Run `ledger-schema.sql` in the Supabase SQL editor.

## 2. Files

| from | to |
|---|---|
| `precursor-engine.js` | `lib/precursor-engine.js` (replaces the current file) |
| `signal-ledger.js` | `lib/signal-ledger.js` (new) |
| `ledger-endpoint.js` | `api/ledger.js` (new) |

The engine replacement is behaviour-identical — verified byte-for-byte on 9
datasets. It is purely the 8.7x speedup.

## 3. `api/cron.js`

Where the cron already computes a precursor forecast per watched target, add two
calls. Record first, resolve second, so an episode opened this tick is never
scored by the same tick.

```js
const { recordObservation, resolveEpisodes } = require('../lib/signal-ledger');

// after you have `analysis = analyzePrecursors(draws, target)`
if (analysis?.ok && analysis.hitTierForecast) {
  await recordObservation(target, analysis.hitTierForecast, latestDrawId);
}

// once per tick, after all targets are recorded
const loadDraws = (from, to) =>
  db(`hotspot_draws?select=draw_id,numbers&draw_id=gte.${from}&draw_id=lte.${to}&order=draw_id.asc`);

await resolveEpisodes(loadDraws, latestDrawId);
```

To also log MEDIUM — worth doing, since the control showed it fires on 63% of
noise checks and the ledger will demonstrate that from your own data:

```js
await recordObservation(target, analysis.hitTierForecast, latestDrawId, {
  trackStatuses: ['STRONG', 'MEDIUM']
});
```

## What the report answers

`GET /api/ledger` returns, for every status and every target:

```
episodes          how many independent events, not how many checks
successes         4+ inside the fixed window
expectedByChance  the exact hypergeometric expectation for the same window
lift              observed / expected
pValue            exact binomial, one-sided
minimumDetectableLift   what this sample size could have found
powerPlan         how many episodes are still needed
```

## How long until it settles the question

The chance rate for a 4+ inside 5 draws is 6.21%. From that:

| to prove | episodes needed |
|---|---|
| 5x edge | 20 |
| 3x edge | 43 |
| **2x edge** | **136** |
| 1.5x edge | 470 |

This is the payoff of targeting 4+ rather than 5/5. Proving a 2x edge on 5/5
would take about 4,080 signals; on 4+ it takes 136. At roughly 11 STRONG
episodes a day across 6 targets, **136 episodes is under two weeks**.

Verified behaviour of the ledger itself:

- 18 consecutive observations across two runs collapse to 2 episodes
- a window with missing draws is skipped, never recorded as a failure
- on 1,200 episodes over random draws: 64 successes against 74.5 expected,
  lift 0.86, p = 0.91 — correctly reports no edge
- with a genuine edge planted: 1.5x detected at p = 3.7e-4, 2x at p = 8.3e-10,
  3x at p = 7.5e-14

So it is neither blind nor credulous. Whatever it reports after 136 episodes is
your answer, measured on your thresholds, with your data.
