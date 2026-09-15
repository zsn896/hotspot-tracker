"""Read public official results for suspicious archive pairs, without credentials."""
import hashlib
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from draw_repeats import compare, validate


class PageText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.ignored = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.ignored = max(0, self.ignored - 1)

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(data)


def parse_result(html, expected_id):
    parser = PageText()
    parser.feed(html)
    text = re.sub(r'\s+', ' ', ' '.join(parser.parts)).strip()
    identity = re.search(r'Draw Number:\s*(\d{7})', text, re.I)
    timing = re.search(r'Draw Date:\s*([^|]+?)\s*\|\s*Draw Time:\s*([0-9:]+\s*[ap]\.??m\.?)', text, re.I)
    if not identity or int(identity.group(1)) != expected_id or not timing:
        raise ValueError('Official page did not identify the requested draw and time')
    segment = text[timing.end():]
    marker = re.search(r'Draw Results\s*:?\s*', segment, re.I)
    if marker:
        segment = segment[marker.end():]
    segment = re.split(r'Check out the Hot Spot|Hot Spot Payouts|Overall odds|Prize Payouts|Winning Tickets', segment, flags=re.I)[0]
    nums = [int(n) for n in re.findall(r'\b(?:[1-9]|[1-7]\d|80)\b', segment)[:20]]
    if len(nums) != 20 or len(set(nums)) != 20:
        raise ValueError('Official results did not contain 20 distinct numbers')
    return {'drawId': expected_id, 'date': timing.group(1).strip(), 'time': timing.group(2).strip(),
            'numbers': sorted(nums), 'resultTextExcerpt': segment[:600]}


def main():
    directory = Path('draw-repeat-output')
    report = json.loads((directory / 'report.json').read_text())
    raw = Path('archive/training-draws.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != report['inputSha256']:
        raise ValueError('Archive provenance mismatch')
    archive_rows = json.loads(raw)['draws']
    archive = {row['draw_id']: sorted(row['numbers']) for row in archive_rows}
    ids = {report['firstDrawId'], report['lastDrawId']}
    for pair in report['maximumExamples']:
        ids.update((pair['firstDrawId'], pair['secondDrawId']))
    evidence = []
    for draw_id in sorted(ids):
        url = 'https://www.calottery.com/en/draw-games/hot-spot/past-winning-numbers?query=' + str(draw_id)
        entry = {'drawId': draw_id, 'url': url, 'archiveNumbers': archive[draw_id]}
        try:
            request = urllib.request.Request(url, headers={
                'User-Agent': 'HotSpotTrackerResearch/1.0', 'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read()
                entry['httpStatus'] = response.status
            html_path = directory / f'official-{draw_id}.html'
            html_path.write_bytes(data)
            entry['htmlSha256'] = hashlib.sha256(data).hexdigest()
            entry.update(parse_result(data.decode('utf-8', errors='replace'), draw_id))
            entry['archiveMatchesOfficial'] = entry['numbers'] == archive[draw_id]
            entry['status'] = 'verified'
        except urllib.error.HTTPError as error:
            entry.update(status='unavailable', error='HTTP ' + str(error.code))
        except Exception as error:
            entry.update(status='unavailable', error=str(error))
        evidence.append(entry)
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(),
              'inputSha256': report['inputSha256'], 'source': 'Public California Lottery historical pages',
              'records': evidence}
    replacements = {entry['drawId']: entry['numbers'] for entry in evidence
                    if entry['status'] == 'verified' and not entry['archiveMatchesOfficial']}
    if replacements:
        corrected_rows = [{'draw_id': row['draw_id'],
                           'numbers': replacements.get(row['draw_id'], row['numbers'])}
                          for row in archive_rows]
        corrected = compare(validate(corrected_rows, report['drawCount']))
        simulated = report['simulation']['maximaCounts']
        repetitions = report['simulation']['repetitions']
        at_least = sum(n for maximum, n in simulated.items() if int(maximum) >= corrected['maximumShared'])
        result['correctedComparison'] = corrected
        result['correctedMaximumMonteCarloP'] = (at_least + 1) / (repetitions + 1)
    result['correctedDrawIds'] = sorted(replacements)
    result['correctionScope'] = 'In-memory audit copy only. The frozen source artifact and production database are not modified. Only the listed official records were checked.'
    (directory / 'official-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print('OFFICIAL_REPEAT_VERIFICATION ' + json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
