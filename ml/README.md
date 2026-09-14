# CatBoost experiment

This is an exploratory historical experiment for the tracker. It predicts whether
at least four of a fixed target's five numbers will occur together in any of the
next five draws. It does not replace the live signal engine or write historical
predictions into the forward signal ledger.

## Run

Use Python 3.11 and the pinned dependencies:

```sh
python -m pip install -r ml/requirements.txt
python -m unittest discover -s ml -p 'test_*.py' -v
python ml/train_catboost.py --input training-draws.json --output catboost-output
```

Input is an ascending or unsorted array of `{draw_id, numbers}` records, or an
object with `draws` and `targets`. Each draw must have exactly 20 distinct integers
from 1 to 80. Each target has five distinct integers in that range. Duplicate IDs
and invalid numbers fail explicitly; gaps exclude affected feature/outcome windows.

The **CatBoost experiment** GitHub Actions workflow tests every relevant pull
request. On main, or a manual run on main, it obtains up to 20,000 recent draws
and the first six active `STRONG_MANUAL Group*` groups through the protected
`/api/ml-data` endpoint using the existing `CRON_SECRET` secret. The credential
never appears in the browser or artifacts. Keyset pagination fixes the upper draw
watermark so new draws do not shift pages. Fetching retries deployment-not-ready
responses; missing credentials fail closed.

## Frozen protocol

- Use the oldest 60% for training, the next 20% for calibration and the last 20%
  for a held-out test. Windows crossing a split boundary are discarded.
- An origin uses only its completed draw and the preceding 49 draws. All 55
  feature/outcome draws must have consecutive IDs. Origins are spaced five draws
  apart; all compared models receive exactly the same non-overlapping outcomes.
- The 183 features include the last draw, 20-draw frequencies of all 80 numbers,
  target frequencies over 5/20/50 draws, capped gaps since appearance, current
  target matches and recent three/four-match rates. No future number is a feature.
- Fit CatBoost with depth 4, at most 250 trees and a fixed random seed. Only
  calibration chooses early stopping and a mixture weight from 0/.25/.5/.75/1
  toward the smoothed training rate. Weight zero means the baseline was preferred;
  this must not be presented as a CatBoost improvement.
- Compare raw CatBoost, calibrated CatBoost, a standardized regularized logistic
  regression, the smoothed training event rate and the mathematical chance rate.
  Brier score and log loss measure probability quality; smaller is better. They
  are **not accuracy percentages**. The chance rate assumes independent uniform
  draws of 20 numbers from 80 and is about 6.208% per five-draw window.
- Calibration alone chooses from fixed signal thresholds .10/.15/.20/.30. A
  candidate needs at least 20 windows and five successes, with its nominal Wilson
  lower bound above chance. No qualifying threshold means abstention. This is an
  exploratory rule, not a significance claim or a production promotion gate.
- Keep all test predictions, including failures. A slightly better test score
  does not prove a repeatable advantage. Targets may have been selected after
  looking at history, features share past draws, and six targets are compared.
  Independent future observations are needed before claiming an improvement.

The test suite alters all held-out draw contents and checks that training and
calibration features, fitted CatBoost predictions and chosen settings stay the
same. It also checks invalid input, gaps, non-overlapping outcomes and split
boundaries. Native CatBoost needs access to Linux process information; restricted
local sandboxes may block fitting. The GitHub Actions test is the full fit check.

## Results and reproduction

Each run saves `report.json`, per-target model `.cbm` files, metadata with feature
names, and CSVs containing every held-out prediction. Its GitHub artifact also
contains the input snapshot and pinned requirements; download it within its
90-day retention. The report records dependency versions, input SHA-256, source
commit and workflow run ID. The exact input is required to reproduce a run.

`/catboost-lab.html` displays the explicitly published `catboost-report.json`
snapshot. It shows the archive cutoff so a past experiment cannot look like a
live forecast. Training does not automatically overwrite that snapshot or deploy
a model. Publish a completed report after checking the workflow and artifacts.

Repeated runs on overlapping archives do not create independent evidence. The
next evaluation phase is to freeze the model and group selection, record issued
probabilities before future draws, and compare all outcomes to the same baselines.

Official API references: [CatBoost fitting](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_fit),
[CatBoost model files](https://catboost.ai/docs/en/concepts/python-reference_catboost_save_model).
