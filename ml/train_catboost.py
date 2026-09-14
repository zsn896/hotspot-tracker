"""Frozen, chronological CatBoost experiment; never writes production forecasts."""
import argparse
import csv
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import numpy as np
from catboost import CatBoostClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

VERSION = 'CATBOOST_4PLUS_V1'
BASELINE = 1 - (1 - (math.comb(5, 4) * math.comb(75, 16) + math.comb(75, 15)) / math.comb(80, 20)) ** 5
DEFAULT_TARGETS = [[9,17,37,51,56], [9,22,37,56,71], [11,17,47,51,72],
                   [3,13,17,28,50], [3,17,28,50,72], [11,17,47,56,71]]


def clean_draws(raw):
    rows = sorted(raw, key=lambda d: d['draw_id'])
    previous = 0
    for row in rows:
        number = row['draw_id']
        nums = row['numbers']
        if type(number) is not int or number <= previous:
            raise ValueError('Draw IDs must be distinct positive integers')
        if len(nums) != 20 or len(set(nums)) != 20 or any(type(n) is not int or not 1 <= n <= 80 for n in nums):
            raise ValueError('Each draw must contain 20 distinct integers from 1 to 80')
        previous = number
    return rows


def dataset(raw, target):
    if len(target) != 5 or len(set(target)) != 5 or any(type(n) is not int or not 1 <= n <= 80 for n in target):
        raise ValueError('Five distinct target numbers required')
    rows = clean_draws(raw)
    if len(rows) < 1000:
        raise ValueError('At least 1000 draws required')
    ids = np.array([d['draw_id'] for d in rows], dtype=np.int64)
    presence = np.zeros((len(rows), 80), dtype=np.float32)
    for i, row in enumerate(rows):
        presence[i, np.array(row['numbers']) - 1] = 1
    hits = presence[:, np.array(target) - 1].sum(axis=1)
    features, labels, issued, ends = [], [], [], []
    names = [f'present_{n}' for n in range(1,81)] + [f'frequency20_{n}' for n in range(1,81)]
    for n in target:
        names += [f'target{n}_frequency{w}' for w in (5,20,50)] + [f'target{n}_gap50']
    names += ['current_target_hits', 'three_plus_rate50', 'four_plus_rate50']
    # One origin per five draws, so future outcome windows never overlap.
    for i in range(49, len(rows)-5, 5):
        if not np.all(np.diff(ids[i-49:i+6]) == 1):
            continue
        x = list(presence[i]) + list(presence[i-19:i+1].mean(axis=0))
        for n in target:
            x += [float(presence[i-w+1:i+1,n-1].mean()) for w in (5,20,50)]
            seen = np.flatnonzero(presence[i-49:i+1,n-1])
            x.append(float(49-seen[-1]) if len(seen) else 50.)
        x += [float(hits[i]), float((hits[i-49:i+1]>=3).mean()), float((hits[i-49:i+1]>=4).mean())]
        features.append(x)
        labels.append(int(np.any(hits[i+1:i+6]>=4)))
        issued.append(int(ids[i])); ends.append(int(ids[i+5]))
    x, y = np.asarray(features, dtype=np.float32), np.asarray(labels, dtype=int)
    issued, ends = np.asarray(issued), np.asarray(ends)
    cut1, cut2 = int(ids[int(len(ids)*.6)]), int(ids[int(len(ids)*.8)])
    masks = [ends < cut1, (issued >= cut1) & (ends < cut2), issued >= cut2]
    return x, y, issued, ends, masks, names


def metrics(y, p):
    p = np.clip(np.asarray(p, dtype=float), 1e-8, 1-1e-8)
    return {'episodes':len(y), 'successes':int(y.sum()),
            'brier':float(np.mean((p-y)**2)),
            'logLoss':float(-np.mean(y*np.log(p)+(1-y)*np.log(1-p)))}


def run_target(rows, target, out, iterations=250):
    x, y, issued, ends, masks, names = dataset(rows, target)
    train, valid, test = masks
    if train.sum()<100 or valid.sum()<40 or test.sum()<40 or len(set(y[train]))<2 or y[train].sum()<5:
        return {'target':target, 'status':'insufficient-data', 'counts':[int(m.sum()) for m in masks]}
    model = CatBoostClassifier(iterations=iterations, depth=4, learning_rate=.04,
        loss_function='Logloss', eval_metric='Logloss', random_seed=20260914,
        l2_leaf_reg=10, thread_count=2, verbose=False, allow_writing_files=False,
        has_time=True)
    model.fit(x[train], y[train], eval_set=(x[valid],y[valid]), early_stopping_rounds=35, use_best_model=True)
    empirical = float((y[train].sum()+30*BASELINE)/(train.sum()+30))
    valid_raw = model.predict_proba(x[valid])[:,1]
    # Only calibration chooses how much to shrink CatBoost toward training's base rate.
    weights = [0.,.25,.5,.75,1.]
    weight = min(weights, key=lambda a: metrics(y[valid], a*valid_raw+(1-a)*empirical)['brier'])
    linear = make_pipeline(StandardScaler(), LogisticRegression(C=.1, max_iter=1500, random_state=20260914))
    linear.fit(x[train],y[train])
    raw_p = model.predict_proba(x[test])[:,1]
    p = weight*raw_p+(1-weight)*empirical
    linear_p = linear.predict_proba(x[test])[:,1]
    scores = {'catboost':metrics(y[test],p), 'rawCatboost':metrics(y[test],raw_p),
              'logistic':metrics(y[test],linear_p), 'empirical':metrics(y[test],np.full(test.sum(),empirical)),
              'chance':metrics(y[test],np.full(test.sum(),BASELINE))}
    # Predeclare signal cutoff from calibration only. None means abstain.
    thresholds = []
    calibrated = weight*valid_raw+(1-weight)*empirical
    for threshold in (.10,.15,.20,.30):
        select = calibrated >= threshold
        n, h = int(select.sum()), int(y[valid][select].sum())
        if n>=20 and h>=5:
            z=1.96; rate=h/n
            lower=(rate+z*z/(2*n)-z*math.sqrt(rate*(1-rate)/n+z*z/(4*n*n)))/(1+z*z/n)
            if lower>BASELINE:
                thresholds.append((lower,threshold))
    threshold = max(thresholds)[1] if thresholds else None
    selected = p>=threshold if threshold is not None else np.zeros(len(p),dtype=bool)
    n, h = int(selected.sum()), int(y[test][selected].sum())
    tag = '-'.join(map(str,target))
    model.save_model(str(out / (tag+'.cbm')))
    # Every test prediction is retained, not just the successes.
    with (out/(tag+'-test.csv')).open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['issued_after_draw','window_end_draw','outcome','catboost','raw_catboost','logistic','empirical','chance','selected'])
        for row in zip(issued[test],ends[test],y[test],p,raw_p,linear_p):
            w.writerow([*row,empirical,BASELINE,int(threshold is not None and row[3]>=threshold)])
    important = sorted(zip(names, model.feature_importances_), key=lambda v:-v[1])[:10]
    result={'target':target,'status':'evaluated','model':VERSION,'treeCount':model.tree_count_,
        'calibrationWeight':weight,'empiricalProbability':empirical,'threshold':threshold,
        'split':[{'count':int(m.sum()),'firstOrigin':int(issued[m][0]),'lastOutcome':int(ends[m][-1])} for m in masks],
        'metrics':scores,'selectedSignals':{'episodes':n,'successes':h,'failures':n-h,'rate':h/n if n else None},
        'beatsAllBaselines':bool(scores['catboost']['brier']<min(scores['logistic']['brier'],scores['chance']['brier'],scores['empirical']['brier'])),
        'featureNames':names,
        'topTrainingFeatures':[{'name':name,'importance':float(value)} for name,value in important],
        'productionEnabled':False}
    (out/(tag+'-metadata.json')).write_text(json.dumps(result,indent=2))
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True);parser.add_argument('--output',default='catboost-output')
    args=parser.parse_args()
    raw=Path(args.input).read_bytes();payload=json.loads(raw)
    rows=clean_draws(payload['draws'] if isinstance(payload,dict) else payload)
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    targets=payload.get('targets',DEFAULT_TARGETS) if isinstance(payload,dict) else DEFAULT_TARGETS
    if not targets: raise ValueError('No active five-number targets to evaluate')
    report={'model':VERSION,'generatedAt':datetime.now(timezone.utc).isoformat(),'inputSha256':hashlib.sha256(raw).hexdigest(),
        'dataSource':'project-archive' if isinstance(payload,dict) and payload.get('ok') is True else 'input-file',
        'drawCount':len(rows),'firstDrawId':rows[0]['draw_id'],'lastDrawId':rows[-1]['draw_id'],
        'sourceCommit':os.environ.get('GITHUB_SHA'), 'workflowRunId':os.environ.get('GITHUB_RUN_ID'),
        'dependencies':{name:version(name) for name in ('catboost','numpy','scikit-learn')},
        'chance':BASELINE,'targetSource':'exported-targets' if isinstance(payload,dict) and 'targets' in payload else 'fixed-defaults',
        'protocol':'60/20/20 chronological; full non-overlapping five-draw outcomes; all test models use identical origins',
        'productionEnabled':False,'results':[]}
    for target in targets:
        result=run_target(rows,target,out);report['results'].append(result)
        print('TARGET_RESULT '+json.dumps(result),flush=True)
    (out/'report.json').write_text(json.dumps(report,indent=2))
    print('CATBOOST_REPORT '+json.dumps(report),flush=True)


if __name__=='__main__':main()
