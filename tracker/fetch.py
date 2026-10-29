#!/usr/bin/env python3
"""Fetch release dates (never chapter text) for followed series from the MangaUpdates API into releases.json."""
import json, re, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = 'https://api.mangaupdates.com/v1'
HEADERS = {'Content-Type': 'application/json', 'User-Agent': 'ShelfReader/1.0 (personal release tracker)'}

def call(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def last_chapter(text):
    nums = re.findall(r'\d+', text or '')
    return int(nums[-1]) if nums else None

out = []
for s in json.loads((ROOT / 'tracker/series.json').read_text()):
    info = call(f"/series/{s['mu']}")
    hits = call('/releases/search', {'search': str(s['mu']), 'search_type': 'series', 'perpage': 60, 'orderby': 'date', 'asc': 'desc'})['results']
    first_seen = {}
    for h in hits:
        r = h['record']
        groups = ' '.join(g['name'] for g in r['groups'])
        if s['groups'] and not any(g.lower() in groups.lower() for g in s['groups']):
            continue
        ch = last_chapter(r['chapter'])
        if ch and (ch not in first_seen or r['release_date'] < first_seen[ch]):
            first_seen[ch] = r['release_date']
    releases = sorted(({'ch': c, 'date': d} for c, d in first_seen.items()), key=lambda x: (x['date'], x['ch']))[-30:]
    out.append({**{k: v for k, v in s.items() if k not in ('mu', 'groups')},
                'url': s.get('url') or info.get('url'), 'status': info.get('status') or '', 'releases': releases})

data = json.dumps({'series': out}, indent=1, ensure_ascii=False) + '\n'
target = ROOT / 'releases.json'
if not target.exists() or target.read_text() != data:
    target.write_text(data)
    print('releases.json updated')
else:
    print('no change')
