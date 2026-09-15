# Complete-draw repeat audit

The user asks whether the same 20-number Hot Spot draw recurs within a week.
This audit compares every unordered pair among the last 2,100 consecutive draw
IDs in the existing 20,000-draw CatBoost snapshot. It ignores number order and
checks exact duplicates, the full overlap histogram, maximum similarity and
predeclared draw-ID lags. Bullseye identity is outside this audit's scope.

The input is frozen to Actions run 34898569138 and SHA-256
`cd7cbe315d1372f28cc1bd06243a97a8fe80b3d29c3e6e0eabff6870bbd76f0f`.
The workflow reads that artifact directly inside GitHub. It requires only
repository contents/artifact read permission and does not access Supabase,
CRON_SECRET or the production signal engine. Source artifacts expire after
90 days; rerunning later requires an explicitly selected available snapshot.

At 300 draws per operating day, 2,100 draws approximate seven days of activity.
The snapshot has no dates/times, so this is not presented as seven named complete
calendar days. Likewise, a lag of 300 IDs is not verified same-clock-time data.

Under the reference model, each draw is an independent uniform sample of 20
distinct numbers from 1..80. Pairwise overlap is hypergeometric. Expected overlap
is five, and the probability of an exact pair is `1 / C(80,20)`. The expected
count of exact pairs is also a union-bound upper limit on the probability of any
repeat in the window. Histogram rows are expected counts, not independent tests.

The predeclared simulation statistic is the **largest overlap among all pairs**.
Generate 199 independent reference windows of the same length using Python's
fixed random seed 20260915; compare each window's maximum with the observed
maximum. Report `(1 + number_at_least_observed) / (1 + repetitions)` as the Monte
Carlo p value, with resolution 0.005. This accounts for searching every pair
within a window; it does not certify all possible patterns or independence.
Lag summaries are descriptive and must not be mined for significance claims.

Run with Python 3.11 (no third-party dependencies):

```sh
python -m unittest discover -s analysis -p 'test_*.py' -v
python analysis/draw_repeats.py --input training-draws.json \
  --expected-sha cd7cbe315d1372f28cc1bd06243a97a8fe80b3d29c3e6e0eabff6870bbd76f0f
```

The report includes provenance, all histogram counts, lag summaries and up to
12 pairs with maximum overlap. Check any suspicious pair against the
[official Hot Spot archive](https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers)
before interpreting it. This is a data audit, not a prediction engine.

`verify_repeats.py` makes one unauthenticated read of each maximum-overlap draw
and the two window boundaries from the official historical pages. It checks
the page's own draw ID, records date/time and numbers, compares them with the
archive, and saves public HTML plus hashes and a verification JSON. HTTP or
parsing failures are reported as unavailable, never treated as confirmation.
