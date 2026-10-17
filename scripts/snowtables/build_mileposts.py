#!/usr/bin/env python3
"""
Build coordinates for NWS Flagstaff (FGZ) Snow Tables roadway mileposts from
ADOT's milepost layer (azgeo.az.gov).

For each Snow Tables road it queries only that route's active mainline posts
(RETIRED = 0, RTE_TYPE = 'Main') in WGS84, takes the post whose MPnum matches
each "MP <n>" label (preferring the cardinal-direction post, CARD = 'Y'), and
linearly interpolates between neighbouring posts when a number is missing.

Hand-verified coordinates in data/snowtables/fgz_mileposts_overrides.json
({road: {"MP n": {lat, lon, ref}}}) always win - e.g. SR 64 MP 240-260 inside Grand
Canyon National Park, where ADOT has no posts (Desert View Drive, NPS-maintained).

Outputs:
  data/snowtables/fgz_mileposts.json          {road: {"MP n": {lat, lon, elev_ft, source, ref, confidence}}}
  <review-dir>/fgz_mileposts_review.geojson   all posts, for visual checking in CloudTAK
  <review-dir>/fgz_mileposts_review.md        interpolated / missing posts

Usage (stdlib only):
  python3 -I scripts/snowtables/build_mileposts.py --review-dir plans/snowtables
"""
import argparse
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

SNOWTABLES_URL = 'https://www.weather.gov/source/fgz/snowtables/data/snowtable_data.json'
ADOT_LAYER = 'https://azgeo.az.gov/arcgis/rest/services/adot/Mileposts/MapServer/0'
USER_AGENT = 'cloudtak-plugin-livewx snow-tables mileposts (https://github.com/clptak/cloudtak-plugin-livewx)'

# Snow Tables road name -> ADOT ONROAD code (mainline).
ROUTE_CODES = {
    'I-17': 'I 017',
    'I-40': 'I 040',
    'I-15': 'I 015',
    'U.S. Route 60': 'U 060',
    'U.S. Route 89': 'U 089',
    'U.S. Route 89A': 'UA089',
    'U.S. Route 160': 'U 160',
    'U.S. Route 180': 'U 180',
    'U.S. Route 191': 'U 191',
    'State Route 61': 'S 061',
    'State Route 64': 'S 064',
    'State Route 67': 'S 067',
    'State Route 69': 'S 069',
    'State Route 73': 'S 073',
    'State Route 77': 'S 077',
    'State Route 87': 'S 087',
    'State Route 89': 'S 089',
    'State Route 89A': 'SA089',
    'State Route 98': 'S 098',
    'State Route 260': 'S 260',
    'State Route 264': 'S 264',
    'State Route 277': 'S 277',
    'State Route 377': 'S 377',
    'State Route 389': 'S 389',
}

COLORS = {'verified': '#206bc4', 'high': '#2fb344', 'medium': '#f59f00', 'low': '#d63939'}


def get_json(url, params=None):
    if params:
        url = f'{url}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def route_posts(code):
    """Active mainline posts for one ADOT route code, keyed by MPnum."""
    posts = {}
    offset = 0
    while True:
        d = get_json(f'{ADOT_LAYER}/query', {
            # ONROAD carries leading spaces and segment suffixes; match loosely, filter exactly below.
            'where': f"RETIRED = 0 AND RTE_TYPE = 'Main' AND ONROAD LIKE '%{code}%'",
            'outFields': 'OBJECTID,ONROAD,MPnum,CARD,ELEVATION,MPTYPE',
            'outSR': 4326,
            'returnGeometry': 'true',
            'orderByFields': 'OBJECTID',
            'resultOffset': offset,
            'resultRecordCount': 1000,
            'f': 'json',
        })
        feats = d.get('features', [])
        for f in feats:
            a = f['attributes']
            if (a.get('ONROAD') or '').strip() != code or a.get('MPnum') is None:
                continue
            g = f.get('geometry') or {}
            if 'x' not in g:
                continue
            rec = {'lat': round(g['y'], 6), 'lon': round(g['x'], 6), 'elev': a.get('ELEVATION'),
                   'card': (a.get('CARD') or '').strip(), 'oid': a['OBJECTID']}
            cur = posts.get(a['MPnum'])
            # Prefer the cardinal-direction post when both directions are present.
            if cur is None or (cur['card'] != 'Y' and rec['card'] == 'Y'):
                posts[a['MPnum']] = rec
        if not d.get('exceededTransferLimit') or not feats:
            break
        offset += len(feats)
    return posts


def interpolate(posts, mp):
    lower = max((m for m in posts if m < mp), default=None)
    upper = min((m for m in posts if m > mp), default=None)
    if lower is None or upper is None or upper - lower > 10:
        return None
    t = (mp - lower) / (upper - lower)
    a, b = posts[lower], posts[upper]
    return {
        'lat': round(a['lat'] + (b['lat'] - a['lat']) * t, 6),
        'lon': round(a['lon'] + (b['lon'] - a['lon']) * t, 6),
        'elev': None,
        'between': (lower, upper),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--review-dir', required=True)
    ap.add_argument('--repo', default=str(Path(__file__).resolve().parents[2]))
    args = ap.parse_args()

    repo = Path(args.repo)
    out_path = repo / 'data' / 'snowtables' / 'fgz_mileposts.json'
    review = Path(args.review_dir)
    review.mkdir(parents=True, exist_ok=True)

    roads = get_json(SNOWTABLES_URL)['snow_tables']['roadways']
    overrides_path = repo / 'data' / 'snowtables' / 'fgz_mileposts_overrides.json'
    overrides = json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
    out = {}
    features = []
    notes = []
    counts = {'verified': 0, 'high': 0, 'medium': 0, 'missing': 0}

    for road, mps in roads.items():
        code = ROUTE_CODES.get(road)
        if not code:
            notes.append(f'| {road} | (all) | no ADOT route code mapped |')
            counts['missing'] += len(mps)
            continue
        posts = route_posts(code)
        out[road] = {}
        for label in mps:
            m = re.fullmatch(r'MP\s*(\d+)', label.strip())
            if not m:
                notes.append(f'| {road} | {label} | label not in "MP <n>" form |')
                counts['missing'] += 1
                continue
            mp = int(m.group(1))
            ov = overrides.get(road, {}).get(label)
            if ov:
                rec = {'lat': ov['lat'], 'lon': ov['lon'], 'elev_ft': ov.get('elev_ft'), 'source': 'manual',
                       'ref': ov.get('ref', 'manual override'), 'confidence': 'verified'}
            elif mp in posts:
                p = posts[mp]
                rec = {'lat': p['lat'], 'lon': p['lon'], 'elev_ft': p['elev'], 'source': 'adot',
                       'ref': f'ADOT Mileposts OBJECTID {p["oid"]} ({code} MP {mp})', 'confidence': 'high'}
            else:
                ip = interpolate(posts, mp)
                if not ip:
                    notes.append(f'| {road} | {label} | no ADOT post within 10 mi to interpolate (add to fgz_mileposts_overrides.json to map it) |')
                    counts['missing'] += 1
                    continue
                lo, hi = ip['between']
                rec = {'lat': ip['lat'], 'lon': ip['lon'], 'elev_ft': None, 'source': 'adot',
                       'ref': f'interpolated between ADOT {code} MP {lo} and MP {hi}', 'confidence': 'medium'}
                notes.append(f'| {road} | {label} | interpolated between MP {lo} and MP {hi} |')
            out[road][label] = rec
            counts[rec['confidence']] += 1
            features.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [rec['lon'], rec['lat']]},
                'properties': {
                    'callsign': f'{road} {label}',
                    'name': f'{road} {label}',
                    'type': 'u-d-p',
                    'marker-color': COLORS[rec['confidence']],
                    'marker-opacity': 1,
                    'remarks': f"Snow Tables roadway: {road} {label}\n{rec['ref']}\nElevation: {rec['elev_ft'] or '-'} ft",
                    'snow_road': road,
                    'snow_mp': label,
                    'confidence': rec['confidence'],
                },
            })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + '\n')
    (review / 'fgz_mileposts_review.geojson').write_text(
        json.dumps({'type': 'FeatureCollection', 'features': features}, indent=2) + '\n')
    lines = [
        '# FGZ Snow Tables — roadway mileposts for review',
        '',
        f"- Manual overrides: **{counts['verified']}**",
        f"- Exact ADOT posts: **{counts['high']}**",
        f"- Interpolated: **{counts['medium']}**",
        f"- Missing: **{counts['missing']}**",
        '',
        'Import `fgz_mileposts_review.geojson` into CloudTAK: green = exact ADOT post, orange = interpolated.',
        '',
        '| Road | Milepost | Note |',
        '|---|---|---|',
        *notes,
    ]
    (review / 'fgz_mileposts_review.md').write_text('\n'.join(lines) + '\n')
    print(f"roads={len(roads)} manual={counts['verified']} exact={counts['high']} "
          f"interpolated={counts['medium']} missing={counts['missing']}")


if __name__ == '__main__':
    main()
