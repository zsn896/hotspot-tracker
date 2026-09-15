"""Audit complete Hot Spot draws; this produces no prediction or live signal."""
import argparse
import hashlib
import json
import math
import os
import random
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SEED = 20260915
LAGS = (1, 2, 5, 10, 15, 30, 60, 150, 300, 600, 900, 1200, 1500, 1800)


def validate(raw, count):
    if count < 2:
        raise ValueError('At least two draws are required')
    rows = sorted(raw, key=lambda row: row['draw_id'])
    previous = 0
    for row in rows:
        draw_id, nums = row['draw_id'], row['numbers']
        if type(draw_id) is not int or draw_id <= previous:
            raise ValueError('Draw IDs must be distinct positive integers')
        if not isinstance(nums, list) or len(nums) != 20 or len(set(nums)) != 20:
            raise ValueError('Each draw needs 20 distinct numbers')
        if any(type(n) is not int or not 1 <= n <= 80 for n in nums):
            raise ValueError('Numbers must be integers in 1..80')
        previous = draw_id
    if len(rows) < count:
        raise ValueError('The archive is shorter than the requested window')
    selected = rows[-count:]
    if any(b['draw_id'] != a['draw_id'] + 1 for a, b in zip(selected, selected[1:])):
        raise ValueError('The selected archive contains missing draws')
    return selected


def mask(numbers):
    return sum(1 << (n - 1) for n in numbers)


def reference():
    denominator = math.comb(80, 20)
    return [math.comb(20, k) * math.comb(60, 20 - k) / denominator for k in range(21)]


def compare(rows):
    masks = [mask(row['numbers']) for row in rows]
    histogram = [0] * 21
    maximum, examples = -1, []
    for i, left in enumerate(masks):
        for j in range(i + 1, len(masks)):
            common = left & masks[j]
            hits = common.bit_count()
            histogram[hits] += 1
            if hits > maximum:
                maximum, examples = hits, []
            if hits == maximum and len(examples) < 12:
                examples.append({
                    'firstDrawId': rows[i]['draw_id'], 'secondDrawId': rows[j]['draw_id'],
                    'lagDraws': rows[j]['draw_id'] - rows[i]['draw_id'],
                    'matchingNumbers': [n for n in range(1, 81) if common & (1 << (n - 1))],
                    'firstNumbers': sorted(rows[i]['numbers']),
                    'secondNumbers': sorted(rows[j]['numbers']),
                })
    identity = defaultdict(list)
    for row in rows:
        identity[tuple(sorted(row['numbers']))].append(row['draw_id'])
    duplicates = [{'numbers': list(nums), 'drawIds': ids}
                  for nums, ids in identity.items() if len(ids) > 1]
    lag_results = []
    for lag in LAGS:
        if lag >= len(rows):
            continue
        counts = Counter((a & b).bit_count() for a, b in zip(masks, masks[lag:]))
        size = len(rows) - lag
        lag_results.append({'lagDraws': lag, 'pairs': size,
                            'meanShared': sum(k * v for k, v in counts.items()) / size,
                            'maximumShared': max(counts), 'exactRepeats': counts[20]})
    pairs = math.comb(len(rows), 2)
    probabilities = reference()
    return {
        'pairCount': pairs, 'exactRepeatPairs': histogram[20],
        'duplicateCards': duplicates, 'maximumShared': maximum,
        'maximumPairCount': histogram[maximum], 'maximumExamples': examples,
        'meanShared': sum(k * n for k, n in enumerate(histogram)) / pairs,
        'overlapHistogram': [{'sharedNumbers': k, 'observedPairs': histogram[k],
                              'expectedFairPairs': pairs * probabilities[k]} for k in range(21)],
        'atLeast': [{'sharedNumbers': k, 'observedPairs': sum(histogram[k:]),
                    'expectedFairPairs': pairs * sum(probabilities[k:])} for k in (10, 12, 14, 15, 18, 19, 20)],
        'fullRepeatProbabilityUpperBound': min(1., pairs / math.comb(80, 20)),
        'lagComparisons': lag_results,
    }


def simulate_maxima(count, repetitions, seed=SEED):
    rng = random.Random(seed)
    distribution = Counter()
    for repetition in range(repetitions):
        masks = [mask(rng.sample(range(1, 81), 20)) for _ in range(count)]
        maximum = max((left & right).bit_count()
                      for i, left in enumerate(masks) for right in masks[i + 1:])
        distribution[maximum] += 1
        if (repetition + 1) % 25 == 0:
            print('SIMULATION_PROGRESS', repetition + 1, '/', repetitions, flush=True)
    return distribution


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--draws', type=int, default=2100)
    parser.add_argument('--simulations', type=int, default=199)
    parser.add_argument('--output', default='draw-repeat-output/report.json')
    args = parser.parse_args()
    if args.simulations < 1:
        raise ValueError('At least one reference simulation is required')
    raw = Path(args.input).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.expected_sha:
        raise ValueError('Input does not match the pinned archive SHA-256')
    payload = json.loads(raw)
    all_rows = payload['draws'] if isinstance(payload, dict) else payload
    rows = validate(all_rows, args.draws)
    report = compare(rows)
    simulated = simulate_maxima(len(rows), args.simulations)
    at_least = sum(n for maximum, n in simulated.items() if maximum >= report['maximumShared'])
    report.update({
        'auditVersion': 'FULL_DRAW_REPEAT_V1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sourceCommit': os.environ.get('GITHUB_SHA'), 'workflowRunId': os.environ.get('GITHUB_RUN_ID'),
        'inputSha256': digest, 'sourceArchiveDraws': len(all_rows),
        'drawCount': len(rows), 'firstDrawId': rows[0]['draw_id'], 'lastDrawId': rows[-1]['draw_id'],
        'scope': f'Latest {len(rows)} contiguous draws in the frozen CatBoost archive; approximately {len(rows) / 300:g} operating days, not named calendar dates.',
        'ignoredOrder': True, 'bullseyeCompared': False,
        'fairReference': 'Independent uniform draws of 20 distinct numbers from 1..80. All unordered draw pairs are compared.',
        'simulation': {'repetitions': args.simulations, 'seed': SEED,
                       'statistic': 'Maximum shared-number count across every unordered pair in the complete window',
                       'maximaCounts': dict(sorted(simulated.items())),
                       'atLeastObserved': at_least, 'monteCarloP': (at_least + 1) / (args.simulations + 1)},
        'limitations': [
            'Existing archive snapshot, not a fresh live export.',
            'Archive lacks dates/times: lags of 300 draws are not verified same-clock-time comparisons.',
            'An exact repeat must be checked against the official source before interpreting it.',
            'Lag and overlap-histogram comparisons are descriptive; no separate significance claim is made for each.',
            'A lack of extreme repeats does not prove independence or rule out every other dependency.',
            'No prediction, live signal or production model is enabled by this audit.',
        ],
    })
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print('DRAW_REPEAT_REPORT ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
