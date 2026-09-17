"""Separate bounded archive audit, required before fitting larger suspect sets."""
import argparse
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from prepare_training import duplicate_ids, KNOWN_DISCREPANCIES, fetch_official, prepare


def load_reviewed(raw, directory):
    manifest = json.loads((directory/'review-manifest.json').read_text())
    corrected = (directory/'corrected-training-draws.json').read_bytes()
    evidence = (directory/'data-quality.json').read_bytes()
    for data, name in [(raw, 'inputSha256'), (corrected, 'correctedSha256'), (evidence, 'evidenceSha256')]:
        if hashlib.sha256(data).hexdigest() != manifest[name]:
            raise ValueError('Reviewed archive provenance mismatch: ' + name)
    from train_catboost import clean_draws
    return clean_draws(json.loads(corrected)['draws']), json.loads(evidence)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raw = Path(args.input).read_bytes()
    payload = json.loads(raw)
    from train_catboost import clean_draws
    rows = clean_draws(payload['draws'])
    ids = duplicate_ids(rows) | (KNOWN_DISCREPANCIES & {r['draw_id'] for r in rows})
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    print('AUDIT_SCOPE ' + json.dumps({'suspectDraws': len(ids), 'first': min(ids) if ids else None,
                                      'last': max(ids) if ids else None}), flush=True)
    if len(ids) > 200:
        raise ValueError('Official audit exceeds the declared 200-page budget')
    def fetch(i):
        for attempt in range(3):
            try:
                return fetch_official(i)
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)
    cached = {}
    ordered = sorted(ids)
    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, result in zip(ordered, pool.map(fetch, ordered)):
            cached[i] = result
            if len(cached) % 20 == 0:
                print('Official pages verified:', len(cached), 'of', len(ids), flush=True)
    def verified(i):
        return cached[i] if i in cached else fetch(i)
    corrected, evidence = prepare(rows, verified, max_checks=200)
    evidence['checkedAt'] = datetime.now(timezone.utc).isoformat()
    clean_bytes = json.dumps({**payload, 'draws': corrected}).encode()
    evidence_bytes = json.dumps(evidence, indent=2).encode()
    manifest = {'inputSha256': hashlib.sha256(raw).hexdigest(),
                'correctedSha256': hashlib.sha256(clean_bytes).hexdigest(),
                'evidenceSha256': hashlib.sha256(evidence_bytes).hexdigest()}
    (out/'corrected-training-draws.json').write_bytes(clean_bytes)
    (out/'data-quality.json').write_bytes(evidence_bytes)
    (out/'review-manifest.json').write_text(json.dumps(manifest, indent=2))
    print('V2_DATA_QUALITY ' + json.dumps(evidence), flush=True)


if __name__ == '__main__':
    main()
