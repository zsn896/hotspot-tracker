"""Targeted official verification; corrections affect an exported copy only."""
import copy
import hashlib
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'analysis'))
from verify_repeats import parse_result

OFFICIAL = 'https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers?query='
KNOWN_DISCREPANCIES = {3300669, 3300900}


def duplicate_ids(rows):
    cards = defaultdict(list)
    for row in rows:
        cards[tuple(sorted(row['numbers']))].append(row['draw_id'])
    return {i for ids in cards.values() if len(ids) > 1 for i in ids}


def fetch_official(draw_id):
    request = urllib.request.Request(OFFICIAL + str(draw_id), headers={
        'User-Agent': 'HotSpotTrackerResearch/2.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read()
    result = parse_result(data.decode('utf-8', errors='replace'), draw_id)
    result['htmlSha256'] = hashlib.sha256(data).hexdigest()
    return result


def prepare(rows, fetcher=fetch_official, max_checks=100):
    from train_catboost import clean_draws
    original = clean_draws(rows)
    corrected = copy.deepcopy(original)
    by_id = {r['draw_id']: r for r in corrected}
    pending = duplicate_ids(corrected) | (KNOWN_DISCREPANCIES & by_id.keys())
    print("TRAINING_ARCHIVE_SUSPECTS " + json.dumps({"count": len(pending), "drawIds": sorted(pending)}), flush=True)
    records, checked = [], set()
    # If a correction creates a different duplicate, verify that pair too.
    while pending:
        if len(checked | pending) > max_checks:
            raise ValueError(f'More than {max_checks} suspect draws: require a separate archive audit')
        for draw_id in sorted(pending):
            official = fetcher(draw_id)  # Any missing/wrong official page aborts training.
            if official['drawId'] != draw_id:
                raise ValueError('Official draw identity mismatch')
            clean_draws([{'draw_id': draw_id, 'numbers': official['numbers']}])
            before = sorted(by_id[draw_id]['numbers'])
            after = sorted(official['numbers'])
            records.append({**official, 'url': OFFICIAL + str(draw_id),
                            'archiveNumbers': before, 'changed': before != after})
            by_id[draw_id]['numbers'] = after
            checked.add(draw_id)
        pending = duplicate_ids(corrected) - checked
    return corrected, {'scope': 'Targeted verification only; not a full official archive audit. Production database unchanged.',
                       'checkedDraws': len(records), 'correctedDrawIds': [r['drawId'] for r in records if r['changed']],
                       'remainingVerifiedDuplicateIds': sorted(duplicate_ids(corrected)), 'records': records}
