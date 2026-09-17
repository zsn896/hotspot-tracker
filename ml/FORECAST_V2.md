# Forecast V2

[Completed evaluation and official corrections (Arabic)](FORECAST_V2_RESULTS.md).

The objective remains at least four of a fixed group's five numbers together in
one of the next five draws. This changes the prediction algorithm, not numeric
input. It estimates an event probability; it cannot guarantee future numbers.

## Changes

- Add 60 past-only pair/triple co-occurrence features (5/20/50 draws) to the
  existing 183 features. These are hypotheses to test, not established predictors.
- Compare three predefined models: the original 183-feature depth-4/l2=10
  configuration and joint-feature depth-2/depth-4 models with l2=30.
- Separate training, early stopping/model selection, probability calibration and
  final testing. The old experiment reused the same phase for early stopping and
  probability calibration. Separating them reduces reuse of calibration outcomes.
- Allow shrinkage toward either theoretical chance or the smoothed training
  rate. A zero model weight is explicitly a baseline, not machine-learning lift.
- Freeze six previously specified groups and the test start at **3301381**, after
  the last draw examined in the published repeat audit. Of the pre-test history,
  the oldest 75% trains, the next 12.5% tunes, and the final 12.5% calibrates.
  Purge outcome windows crossing boundaries. All model comparisons use the same
  non-overlapping five-draw test outcomes. Gaps exclude affected windows.
- The legacy comparator is refitted under this new split and independently
  calibrated. It is not the exact old published model/report.
- Choose signal thresholds on calibration only. Require 30 windows, five hits
  and a Wilson lower bound with z=3.1 above both reference rates. An exploratory
  test gate also requires 100 test windows, 30 selected signals, five hits,
  lower-bound advantage over chance, Brier advantage over chance/empirical/legacy,
  and chance advantage in both chronological test halves. The conservative z
  does not remove all selection/dependence bias. No automatic production promotion.

## Data quality

Before fitting, verify both previously erroneous IDs and every exact duplicate
card against each draw's own official page. Never assume a duplicate is an error:
keep officially confirmed repeats. Correct only the exported training copy and
retain before/after values, official URLs and page hashes. Missing/mismatched
pages abort training. The direct training path allows at most 100 suspect draws. The separate archive
audit stage supports at most 200, with four concurrent public-page requests. It
saves reviewed data and a hash-bound manifest before training can consume it.
A larger scope aborts instead of silently dropping records.
This targeted check does **not** certify the rest of the archive or fix Supabase.

## Run and outputs

Use the dependencies in `requirements.txt`:

```sh
python -m unittest discover -s ml -p 'test_*.py' -v
python ml/forecast_v2.py --input training-draws.json
```

The `Forecast V2 evaluation` workflow obtains the protected archive using the
existing secret, then saves the original and corrected snapshots, audit evidence,
models, calibration metadata and **all** test predictions. No credential is
included in artifacts. Artifacts expire after 90 days. The report includes both
input hashes and the source commit/run. Fixed seeds make fitting reproducible;
re-fetching official pages later may change corrections, so retain the snapshots.

This is a retrospective test on a newer period, not a prospective live ledger.
Reruns on the same cutoff/overlapping draws are not independent confirmations.
Do not select a new cutoff after seeing results or activate a losing candidate.

Source: [CatBoost fit/early stopping and validation](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_fit).
