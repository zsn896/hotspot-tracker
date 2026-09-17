import copy
import tempfile
import unittest
from pathlib import Path

import numpy as np
from catboost import CatBoostClassifier
from test_catboost import fixture
from forecast_v2 import make_dataset, run_target, assess, BASELINE
from prepare_training import prepare


class ForecastV2Tests(unittest.TestCase):
    def test_four_phases_and_no_future_features(self):
        rows = fixture()
        changed = copy.deepcopy(rows)
        for row in changed[2800:]:
            row['numbers'] = list(range(1, 21))
        a = make_dataset(rows, [1, 2, 3, 4, 5], 2801)
        b = make_dataset(changed, [1, 2, 3, 4, 5], 2801)
        self.assertEqual(a[0].shape[1], 243)
        for left, right in zip(a[4], a[4][1:]):
            self.assertLess(a[3][left].max(), a[2][right].min())
        for mask in a[4][:3]:
            np.testing.assert_array_equal(a[0][mask], b[0][mask])
            np.testing.assert_array_equal(a[1][mask], b[1][mask])
        self.assertTrue(np.all(a[2][a[4][-1]] >= 2801))
        gap = make_dataset([r for r in rows if r['draw_id'] != 2900], [1, 2, 3, 4, 5], 2801)
        self.assertFalse(any(s-49 <= 2900 <= e for s, e in zip(gap[2], gap[3])))

    def test_test_labels_cannot_select_or_fit_model(self):
        rows = fixture()
        changed = copy.deepcopy(rows)
        for row in changed[2800:]:
            row['numbers'] = list(range(1, 21))
        with tempfile.TemporaryDirectory() as da, tempfile.TemporaryDirectory() as db:
            a = run_target(rows, [1, 2, 3, 4, 5], Path(da), 2801, iterations=12)
            b = run_target(changed, [1, 2, 3, 4, 5], Path(db), 2801, iterations=12)
            for key in ('selectedModel', 'calibration', 'threshold', 'tuningScores'):
                self.assertEqual(a[key], b[key])
            ma = CatBoostClassifier().load_model(str(Path(da)/'1-2-3-4-5.cbm'))
            mb = CatBoostClassifier().load_model(str(Path(db)/'1-2-3-4-5.cbm'))
            x = make_dataset(rows, [1, 2, 3, 4, 5], 2801)[0][:20, :len(a['featureNames'])]
            np.testing.assert_allclose(ma.predict_proba(x), mb.predict_proba(x))
            self.assertEqual(len((Path(da)/'1-2-3-4-5-test.csv').read_text().splitlines())-1, a['metrics']['v2']['episodes'])
            self.assertFalse(a['productionEnabled'])

    def test_constant_predictions_cannot_qualify(self):
        y = np.array([int(i % 10 == 0) for i in range(200)])
        p = np.full(200, BASELINE)
        result = assess(y, p, {'chance': p, 'empirical': p, 'legacy': p}, None)
        self.assertFalse(result['eligibleForProspectiveTrial'])
        self.assertEqual(result['episodes'], 0)

    def test_duplicate_corrections_preserve_original_and_verify_identity(self):
        rows = fixture(20)
        rows[1]['numbers'] = list(rows[0]['numbers'])
        original = copy.deepcopy(rows)
        replacement = list(range(1, 21))
        def official(i):
            return {'drawId': i, 'numbers': replacement if i == 2 else rows[i-1]['numbers']}
        result, audit = prepare(rows, official)
        self.assertEqual(rows, original)
        self.assertEqual(result[1]['numbers'], replacement)
        self.assertEqual(audit['correctedDrawIds'], [2])
        self.assertEqual(audit['checkedDraws'], 2)
        with self.assertRaises(ValueError):
            prepare(rows, lambda i: {'drawId': i+1, 'numbers': replacement})
        with self.assertRaises(RuntimeError):
            prepare(rows, lambda i: (_ for _ in ()).throw(RuntimeError('Official unavailable')))


if __name__ == '__main__':
    unittest.main()
