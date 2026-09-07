# Hot Spot — engine v2

A drop-in change set for `zsn896/hotspot-tracker`. The idea is untouched:
precursor triples, the 70/30 discovery/validation split, the 4+ tier, and the
six STRONG conditions all work exactly as they did.

Two things are added: an 8.7x speedup with identical output, and a ledger that
measures what actually happens after a signal fires.

## Contents

```
lib/precursor-engine.js    REPLACES the current file. Behaviour identical.
lib/signal-ledger.js       NEW. Records episodes and scores their outcomes.
api/ledger.js              NEW. GET /api/ledger returns the report.
ledger-schema.sql          Run once in the Supabase SQL editor.
WIRING.md                  The three edits needed in api/cron.js.
CALIBRATION.md             The control experiment and what it found.
reference/                 The original engine, kept for comparison.
verify/                    Scripts that re-prove every claim below.
```

## Install

1. Run `ledger-schema.sql` in Supabase.
2. Copy `lib/` and `api/` over your project. `api/lib.js` is **not** touched.
3. Add the two calls described in `WIRING.md` to `api/cron.js`.

Nothing else changes. No new dependencies.

## Verify it yourself

Do not take any of this on trust. From the package root:

```bash
node verify/verify-identical.js     # optimised engine == original engine
node verify/ledger-selftest.js      # episode counting, window integrity, null result
node verify/ledger-detection.js     # confirms it detects a real edge
node verify/control-calibration.js  # ~2.5 min: STRONG on purely random draws
```

The first two run offline with no database.

## What was measured

**Speed** — identical output on 9 datasets, verified with `JSON.stringify`:

| draws | original | optimised | speedup |
|---|---|---|---|
| 3,000 | 4,749 ms | 543 ms | 8.7x |
| 8,000 | 10,998 ms | 1,269 ms | 8.7x |

At 8,000 draws the original took 11 seconds, over Vercel's 10-second default
limit — `/api/health` was not merely slow, it was timing out.

**Calibration** — the engine run unmodified on draws from a fair random
generator, 320 live checks:

| status | rate on pure noise |
|---|---|
| STRONG | 0.63% (95% CI 0.2%–2.2%) |
| MEDIUM | 63.4% |

The six STRONG conditions hold up as a conjunction. Individually they do not:
`validationLift >= 1.60` is exceeded by noise 65% of the time, and the median
lift produced by noise is 2.12. MEDIUM fires on two thirds of noise checks.

**Ledger** — 1,200 episodes over random draws: 64 successes against 74.5
expected, lift 0.86, p = 0.91, correctly reporting no edge. With a real edge
planted: 1.5x detected at p = 3.7e-4, 2x at p = 8.3e-10, 3x at p = 7.5e-14.

## The number that settles it

A 4+ inside a 5-draw window happens 6.21% of the time by chance.

| to prove | episodes needed |
|---|---|
| 5x edge | 20 |
| 3x edge | 43 |
| **2x edge** | **136** |
| 1.5x edge | 470 |

At roughly 11 STRONG episodes a day across 6 targets, 136 episodes is under two
weeks. After that, `GET /api/ledger` answers the question with your thresholds
and your data — proof or refutation, with no argument required from anyone.
