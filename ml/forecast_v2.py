"""Group-event forecast candidates, selected before a fixed later test period."""
import argparse
import csv
import hashlib
import json
import os
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

import numpy as np
from catboost import CatBoostClassifier
from train_catboost import BASELINE, DEFAULT_TARGETS, clean_draws, dataset, metrics
from prepare_training import prepare

VERSION = 'CATBOOST_4PLUS_V2'
# Last draw examined in the published September 15 audit; never move on reruns.
TEST_START = 3301381


def make_dataset(rows, target, test_start=TEST_START):
    rows = clean_draws(rows)
    x, y, issued, ends, _, names = dataset(rows, target)
    if not len(issued):
        raise ValueError('No contiguous outcome windows')
    index = {r['draw_id']: i for i, r in enumerate(rows)}
    flags = np.array([[int(n in r['numbers']) for n in target] for r in rows])
    groups = list(combinations(range(5), 2)) + list(combinations(range(5), 3))
    extra = []
    for draw_id in issued:
        i = index[int(draw_id)]
        extra.append([float(flags[i-w+1:i+1, list(group)].all(axis=1).mean())
                      for group in groups for w in (5, 20, 50)])
    names += ['joint_' + '_'.join(str(target[j]) for j in group) + f'_rate{w}'
              for group in groups for w in (5, 20, 50)]
    x = np.column_stack((x, np.array(extra, dtype=np.float32)))
    history = [r['draw_id'] for r in rows if r['draw_id'] < test_start]
    if len(history) < 1000:
        raise ValueError('At least 1000 pre-test draws required')
    a, b = history[int(len(history)*.75)], history[int(len(history)*.875)]
    # Purge outcomes crossing a phase boundary. Shared past features are allowed.
    masks = [ends < a, (issued >= a) & (ends < b),
             (issued >= b) & (ends < test_start), issued >= test_start]
    return x, y, issued, ends, masks, names


def blend(y, raw, empirical):
    choices = [(name, value, weight) for name, value in [('chance', BASELINE), ('empirical', empirical)]
               for weight in (0., .25, .5, .75, 1.)]
    name, base, weight = min(choices, key=lambda c: metrics(y, c[2]*raw+(1-c[2])*c[1])['brier'])
    return {'base': name, 'baseProbability': base, 'weight': weight}


def predict(raw, calibration):
    return calibration['weight']*raw + (1-calibration['weight'])*calibration['baseProbability']


def lower(h, n, z=3.1):
    if not n:
        return 0.
    p = h/n
    return (p+z*z/(2*n)-z*np.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n)


def assess(y, p, references, threshold):
    selected = p >= threshold if threshold is not None else np.zeros(len(y), dtype=bool)
    n, h = int(selected.sum()), int(y[selected].sum())
    brier = metrics(y, p)['brier']
    halves = []
    for idx in np.array_split(np.arange(len(y)), 2):
        halves.append({'episodes': len(idx), 'brier': metrics(y[idx], p[idx])['brier'],
                       'chanceBrier': metrics(y[idx], references['chance'][idx])['brier']})
    passed = (len(y) >= 100 and n >= 30 and h >= 5 and lower(h, n) > BASELINE
              and all(brier < metrics(y, ref)['brier'] for ref in references.values())
              and all(r['episodes'] >= 40 and r['brier'] < r['chanceBrier'] for r in halves))
    return {'episodes': n, 'successes': h, 'failures': n-h, 'rate': h/n if n else None,
            'conservativeLowerBound': float(lower(h, n)), 'halves': halves,
            'eligibleForProspectiveTrial': bool(passed), 'productionEnabled': False}


def run_target(rows, target, out, test_start=TEST_START, iterations=250):
    x, y, issued, ends, masks, names = make_dataset(rows, target, test_start)
    train, tune, cal, test = masks
    counts = [int(m.sum()) for m in masks]
    if any(n < minimum for n, minimum in zip(counts, (100, 40, 40, 40))) or y[train].sum() < 5 or len(set(y[train])) < 2:
        return {'target': target, 'status': 'insufficient-data', 'counts': counts, 'productionEnabled': False}
    empirical = float((y[train].sum()+30*BASELINE)/(train.sum()+30))
    models = []
    # Three declared candidates, not an open-ended search over the test period.
    for name, depth, l2, width in [('legacy', 4, 10, 183), ('joint-shallow', 2, 30, x.shape[1]), ('joint-depth4', 4, 30, x.shape[1])]:
        model = CatBoostClassifier(iterations=iterations, depth=depth, learning_rate=.04,
            l2_leaf_reg=l2, loss_function='Logloss', eval_metric='Logloss', random_seed=20260917,
            thread_count=2, verbose=False, allow_writing_files=False, has_time=True)
        model.fit(x[train, :width], y[train], eval_set=(x[tune, :width], y[tune]),
                  early_stopping_rounds=35, use_best_model=True)
        score = metrics(y[tune], model.predict_proba(x[tune, :width])[:, 1])['brier']
        models.append((score, name, model, width))
    winner = min(models, key=lambda r: r[0])
    _, name, model, width = winner
    calibration = blend(y[cal], model.predict_proba(x[cal, :width])[:, 1], empirical)
    p_cal = predict(model.predict_proba(x[cal, :width])[:, 1], calibration)
    thresholds = []
    for t in (.10, .15, .20, .30):
        take = p_cal >= t
        n, h = int(take.sum()), int(y[cal][take].sum())
        if n >= 30 and h >= 5 and lower(h, n) > max(BASELINE, empirical):
            thresholds.append((lower(h, n), t))
    threshold = max(thresholds)[1] if thresholds else None
    p = predict(model.predict_proba(x[test, :width])[:, 1], calibration)
    legacy = models[0][2]
    legacy_calibration = blend(y[cal], legacy.predict_proba(x[cal, :183])[:, 1], empirical)
    refs = {'chance': np.full(test.sum(), BASELINE), 'empirical': np.full(test.sum(), empirical),
            'legacy': predict(legacy.predict_proba(x[test, :183])[:, 1], legacy_calibration)}
    assessment = assess(y[test], p, refs, threshold)
    tag = '-'.join(map(str, target))
    model.save_model(str(out / (tag+'.cbm')))
    with (out/(tag+'-test.csv')).open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['issued_after_draw', 'window_end_draw', 'outcome', 'v2', 'legacy', 'empirical', 'chance', 'selected'])
        for row in zip(issued[test], ends[test], y[test], p, refs['legacy']):
            writer.writerow([*row, empirical, BASELINE, int(threshold is not None and row[3] >= threshold)])
    result = {'target': target, 'status': 'evaluated', 'model': VERSION, 'selectedModel': name,
              'treeCount': model.tree_count_, 'calibration': calibration, 'threshold': threshold,
              'tuningScores': {m[1]: m[0] for m in models}, 'featureNames': names[:width],
              'split': [{'count': int(m.sum()), 'firstOrigin': int(issued[m][0]), 'lastOutcome': int(ends[m][-1])} for m in masks],
              'metrics': {'v2': metrics(y[test], p), **{k: metrics(y[test], v) for k, v in refs.items()}},
              'assessment': assessment, 'productionEnabled': False}
    (out/(tag+'-metadata.json')).write_text(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', default='forecast-v2-output')
    args = parser.parse_args()
    raw = Path(args.input).read_bytes()
    payload = json.loads(raw)
    rows, quality = prepare(payload['draws'])
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    corrected = json.dumps({**payload, 'draws': rows}).encode()
    (out/'corrected-training-draws.json').write_bytes(corrected)
    (out/'data-quality.json').write_text(json.dumps(quality, indent=2))
    # Freeze the same six groups already specified before this fresh holdout.
    report = {'model': VERSION, 'generatedAt': datetime.now(timezone.utc).isoformat(),
              'sourceCommit': os.environ.get('GITHUB_SHA'), 'workflowRunId': os.environ.get('GITHUB_RUN_ID'),
              'inputSha256': hashlib.sha256(raw).hexdigest(), 'correctedInputSha256': hashlib.sha256(corrected).hexdigest(),
              'drawCount': len(rows), 'firstDrawId': rows[0]['draw_id'], 'lastDrawId': rows[-1]['draw_id'],
              'testStartDrawId': TEST_START, 'targetSource': 'fixed-six-targets-before-test-cutoff',
              'dataQuality': quality, 'productionEnabled': False, 'results': [],
              'limitations': 'Historical retrospective evaluation. Same fixed test start on every rerun; reruns are not independent evidence. Targeted verification cannot certify all rows. Gates are exploratory, not proof of predictability.'}
    for target in DEFAULT_TARGETS:
        result = run_target(rows, target, out)
        report['results'].append(result)
        print('V2_TARGET_RESULT ' + json.dumps(result), flush=True)
    (out/'report.json').write_text(json.dumps(report, indent=2))
    print('FORECAST_V2_REPORT ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
