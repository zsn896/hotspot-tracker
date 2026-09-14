import copy
import random
import tempfile
import unittest
from pathlib import Path

import numpy as np
from catboost import CatBoostClassifier
from train_catboost import dataset, clean_draws, run_target, BASELINE


def fixture(n=3500):
    rng=random.Random(20260914)
    return [{'draw_id':i+1,'numbers':rng.sample(range(1,81),20)} for i in range(n)]


class CatBoostTests(unittest.TestCase):
    def test_windows_and_split_boundaries(self):
        rows=fixture();x,y,start,end,masks,names=dataset(rows,[1,2,3,4,5])
        self.assertEqual(x.shape[1],len(names))
        self.assertTrue(np.all(start[1:]>=end[:-1]))
        self.assertLess(end[masks[0]].max(),start[masks[1]].min())
        self.assertLess(end[masks[1]].max(),start[masks[2]].min())
        gap=dataset([r for r in rows if r['draw_id']!=1002],[1,2,3,4,5])
        self.assertFalse(any(s<1002<=e for s,e in zip(gap[2],gap[3])))

    def test_invalid_records_fail_explicitly(self):
        rows=fixture(1100)
        with self.assertRaises(ValueError):clean_draws(rows+[rows[0]])
        broken=copy.deepcopy(rows);broken[0]['numbers'][1]=broken[0]['numbers'][0]
        with self.assertRaises(ValueError):clean_draws(broken)
        with self.assertRaises(ValueError):dataset(rows,[1,1,3,4,5])

    def test_future_changes_cannot_rewrite_features_or_fitted_model(self):
        rows=fixture();changed=copy.deepcopy(rows)
        for r in changed[2800:]:r['numbers']=list(range(1,21))
        a=dataset(rows,[1,2,3,4,5]);b=dataset(changed,[1,2,3,4,5])
        for mask in a[4][:2]:
            np.testing.assert_array_equal(a[0][mask],b[0][mask])
            np.testing.assert_array_equal(a[1][mask],b[1][mask])
        with tempfile.TemporaryDirectory() as da,tempfile.TemporaryDirectory() as db:
            ra=run_target(rows,[1,2,3,4,5],Path(da),iterations=20)
            rb=run_target(changed,[1,2,3,4,5],Path(db),iterations=20)
            self.assertEqual(ra['calibrationWeight'],rb['calibrationWeight'])
            self.assertEqual(ra['threshold'],rb['threshold'])
            ma=CatBoostClassifier().load_model(str(Path(da)/'1-2-3-4-5.cbm'))
            mb=CatBoostClassifier().load_model(str(Path(db)/'1-2-3-4-5.cbm'))
            np.testing.assert_allclose(ma.predict_proba(a[0][:20]),mb.predict_proba(a[0][:20]))
            self.assertEqual(len((Path(da)/'1-2-3-4-5-test.csv').read_text().splitlines())-1,int(a[4][2].sum()))
            self.assertFalse(ra['productionEnabled'])
            self.assertEqual(ra['metrics']['catboost']['episodes'],ra['metrics']['chance']['episodes'])
            self.assertGreater(BASELINE,.062);self.assertLess(BASELINE,.063)


if __name__=='__main__':unittest.main()
