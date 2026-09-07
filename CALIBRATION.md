# Precursor engine: performance rewrite and control calibration

Two things were done, in this order, and nothing else. The algorithm — precursor
triples, the 70/30 discovery/validation split, the 4+ tier, the six STRONG
conditions — is untouched.

## 1. Performance rewrite (behaviour identical)

`precursor-engine.js` replaces three hot paths. No thresholds, no scoring, no
ordering changed.

| | before | after |
|---|---|---|
| `drawHasTriple` | rebuilt `new Set(norm(draw.numbers))` on every call, once per candidate per draw per segment | precomputed byte table, O(1) lookup |
| `futureHitFlags` | rescanned the forward window per candidate per draw | one linear pass per segment, cached |
| `combinations3` | allocated 1,140 arrays + 1,140 strings per draw | triples packed into one integer, zero allocation |

Measured on identical inputs:

| draws | original | optimised | speedup | output identical |
|---|---|---|---|---|
| 3,000 | 4,749 ms | 543 ms | 8.7x | yes |
| 6,000 | 8,199 ms | 1,040 ms | 7.9x | yes |
| 8,000 | 10,998 ms | 1,269 ms | 8.7x | yes |

Verified byte-for-byte with `JSON.stringify` on 6 further datasets and targets:
6/6 identical. Tie-breaking is preserved deliberately — candidate ordering used
to depend on `Map` insertion order, so the integer-keyed map enumerates triples
in the same ascending sequence the old `combinations3` produced.

**This is why the site was slow.** At 8,000 draws a single `analyzePrecursors`
call took 11 seconds, above Vercel's default 10-second function limit, so
`/api/health` was likely timing out intermittently rather than merely lagging.
Throttling the front end reduced how often that happened; it could not fix it.

## 2. Control calibration

The engine was run unmodified against draws from a fair random generator — a
game containing, by construction, nothing to find. 320 live checks.

| status | count | rate on pure noise | 95% CI |
|---|---|---|---|
| MEDIUM | 203 | **63.4%** | 58.0% – 68.5% |
| QUIET | 83 | 25.9% | 21.4% – 31.0% |
| HIT_RESET | 29 | 9.1% | 6.4% – 12.7% |
| LOW | 3 | 0.9% | 0.3% – 2.7% |
| **STRONG** | **2** | **0.63%** | **0.2% – 2.2%** |

### The six STRONG conditions work — as a conjunction

Individually they are weak. Against noise:

| condition | exceeded by noise | median value on noise |
|---|---|---|
| `validationLift >= 1.60` | **65%** of the time | 2.12 |
| `fourPlusScore >= 70` | 38% | — |
| `validationSuccessRate >= 0.16` | 33% | 0.125 |

A lift of 1.60 carries almost no evidence on its own: the *median* lift produced
by pure noise is 2.12, and the maximum observed was 8.56. That is expected —
`best4` is the winner of a search over 240 candidates, and the largest of 240
noisy ratios is large by construction.

Requiring all six simultaneously is what does the work, and it holds the
false-positive rate at 0.63%. That is better than a conventional 5% level.

### But a 0.63% per-check rate is not small here

Hot Spot runs 300 draws a day, and the engine is evaluated on every one.

| targets watched | checks/day | expected FALSE STRONG per day | per month |
|---|---|---|---|
| 1 | 300 | 1.9 | 56 |
| 4 | 1,200 | 7.5 | 225 |
| 6 | 1,800 | 11.3 | 338 |

A false STRONG is followed by a 4+ within 5 draws 6.2% of the time by chance
alone. Watching 6 targets therefore produces roughly **0.7 "successful" STRONG
signals every day from a game with no signal in it**. Over a month that is about
20 apparent confirmations — more than enough to feel like a working system.

## Recommendations that do not touch the idea

1. **Retire MEDIUM, or relabel it.** It fires on two thirds of noise checks. It
   cannot distinguish anything and it is the most frequent thing users see.
2. **Report the expected count next to the observed count.** "STRONG signals
   this month: 41. Expected from chance alone: 338." Same engine, same
   thresholds — the reader simply gets the denominator.
3. **Count episodes, not checks.** A STRONG that persists across 5 draws is one
   event. Scoring it five times inflates every rate.
4. **Track forward outcomes automatically.** Log every STRONG with its window and
   whether a 4+ followed. After ~400 logged episodes the question is settled by
   your own data, at your own thresholds, with no modelling argument required.

Item 4 is the decisive one, and the engine already produces everything it needs.
