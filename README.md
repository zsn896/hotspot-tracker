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
WIRING.md                  Configuration for the integrated cron ledger.
CALIBRATION.md             The control experiment and what it found.
reference/                 The original engine, kept for comparison.
verify/                    Scripts that re-prove every claim below.
```

## Run and verify

Use Node.js 20 or newer. Install the locked dependencies and run the offline suite:

```bash
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

For server settings and optional forward-outcome recording, follow [WIRING.md](WIRING.md) and `.env.example`. The cron integration is included; no manual code insertion is needed. Apply the ledger schema before enabling its environment flag.

The September 2026 code review, corrections, test results and production limitations are documented in [AUDIT.md](AUDIT.md). The historical measurements below predate that review; the current reproducible comparison script contains six datasets.

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

## Interpreting the forward sample

A 4+ inside a 5-draw window happens 6.21% of the time by chance.

| planned alternative | episodes needed under the model |
|---|---|
| 5x edge | 20 |
| 3x edge | 43 |
| **2x edge** | **136** |
| 1.5x edge | 470 |

These sample-size estimates assume independent episodes and the specified effect size. Actual collection time depends on signal frequency. Overlapping targets or outcome windows and repeated comparisons weaken that assumption. A significant result in one sample is not proof of future predictive performance; a non-significant result is not proof that every smaller effect is absent.
