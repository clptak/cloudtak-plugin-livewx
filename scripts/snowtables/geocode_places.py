#!/usr/bin/env python3
"""
Build coordinates for NWS Flagstaff (FGZ) Snow Tables place names.

The Snow Tables feed has no coordinates. Sources, in order of trust:

  1. manual     data/snowtables/fgz_places_overrides.json (hand-verified; always wins)
     (data/snowtables/fgz_places_aliases.json maps NWS labels to the official / common
      name to search for, e.g. "GCNP - South Rim" -> GNIS "Grand Canyon Village ...")
  2. nws        NWS's own lat/lon from the FGZ Snow Forecast feed (ProbSnow_WebData.json)
  3. gnis       USGS Geographic Names Information System (DomesticNames AZ / NM)
  4. osm        OpenStreetMap Nominatim, only for names GNIS cannot resolve

Outputs:
  data/snowtables/fgz_places.json            {name: {lat, lon, source, ref, confidence}} for the plugin
  <review-dir>/fgz_places_review.geojson     geocoded (non-NWS) places, for visual checking in CloudTAK
  <review-dir>/fgz_places_review.md          match details and anything unresolved

Usage (stdlib only; GNIS text files from
https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/):

  python3 -I scripts/snowtables/geocode_places.py \
      --gnis-dir /path/to/gnis --review-dir plans/snowtables [--no-osm]
"""
import argparse
import csv
import difflib
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

SNOWTABLES_URL = 'https://www.weather.gov/source/fgz/snowtables/data/snowtable_data.json'
PROBSNOW_URL = 'https://www.weather.gov/source/fgz/data/ProbSnow_WebData.json'
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
USER_AGENT = 'cloudtak-plugin-livewx snow-tables geocoder (https://github.com/clptak/cloudtak-plugin-livewx)'

# NWS Flagstaff forecast area plus a margin (lat/lon box). The east edge reaches the
# outlying Navajo chapters in New Mexico (To'hajiile, Alamo, Torreon, Ojo Encino).
FGZ_BBOX = (33.2, -114.9, 37.2, -106.5)  # south, west, north, east
NM_NAVAJO_COUNTIES = {'McKinley', 'San Juan', 'Cibola', 'Sandoval', 'Bernalillo', 'Socorro'}

# Preferred GNIS feature classes for a named community, best first.
CLASS_RANK = {
    'Populated Place': 0,
    'Census': 1,
    'Civil': 2,
    'Locale': 3,
    'Area': 4,
    'Park': 4,
    'Summit': 5,
    'Ridge': 6,
    'Range': 6,
    'Plain': 7,
    'Valley': 7,
    'Gap': 7,
    'Falls': 7,
    'Lake': 8,
    'Reservoir': 9,
}

COLORS = {'high': '#2fb344', 'medium': '#f59f00', 'low': '#d63939'}


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def norm(s):
    s = s.lower()
    s = s.replace('&', ' and ')
    s = re.sub(r'\bn\.?\s*m\.?$', ' national monument', s)
    s = re.sub(r'\bn\.?\s*p\.?$', ' national park', s)
    s = re.sub(r'\bmt\.?\b', 'mount', s)
    s = re.sub(r'\bst\.?\b', 'saint', s)
    s = re.sub(r'\bchapter\b', '', s)
    return re.sub(r'[^a-z0-9]', '', s)


def is_subsequence(short, long):
    it = iter(long)
    return all(ch in it for ch in short)


def km(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def in_bbox(lat, lon):
    s, w, n, e = FGZ_BBOX
    return s <= lat <= n and w <= lon <= e


def load_gnis(gnis_dir):
    rows = []
    for state in ('AZ', 'NM'):
        path = Path(gnis_dir) / f'DomesticNames_{state}.txt'
        with open(path, encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f, delimiter='|'):
                try:
                    lat = float(r['prim_lat_dec'])
                    lon = float(r['prim_long_dec'])
                except (TypeError, ValueError):
                    continue
                if not lat or not lon or not in_bbox(lat, lon):
                    continue
                rows.append({
                    'id': r['feature_id'],
                    'name': r['feature_name'],
                    'norm': norm(r['feature_name']),
                    'class': r['feature_class'],
                    'state': state,
                    'county': r['county_name'],
                    'lat': lat,
                    'lon': lon,
                })
    return rows


def expected_state(tab, group):
    return 'NM' if group == 'Navajo Nation in New Mexico' else 'AZ'


def expected_county(tab, group):
    if tab == 'counties' and group.endswith(' County'):
        return group[: -len(' County')]
    return None


def pick(cands, county, anchor):
    """Rank candidates: county match, feature class, distance to the group's anchor."""
    def key(c):
        return (
            0 if county and c['county'] == county else 1,
            CLASS_RANK.get(c['class'], 20),
            km((c['lat'], c['lon']), anchor) if anchor else 0,
        )
    return sorted(cands, key=key)


def geocode_gnis(name, tab, group, gnis, anchor):
    state = expected_state(tab, group)
    county = expected_county(tab, group)
    pool = [g for g in gnis if g['state'] == state and g['class'] in CLASS_RANK]
    if state == 'NM':
        pool = [g for g in pool if g['county'] in NM_NAVAJO_COUNTIES]
    n = norm(name)

    exact = [g for g in pool if g['norm'] == n]
    if exact:
        ranked = pick(exact, county, anchor)
        best = ranked[0]
        community = CLASS_RANK.get(best['class'], 20) <= CLASS_RANK['Locale']
        same_rank = [c for c in ranked if CLASS_RANK.get(c['class'], 20) == CLASS_RANK.get(best['class'], 20)
                     and (not county or c['county'] == best['county'])]
        if community and (len(same_rank) == 1 or (county and best['county'] == county)):
            conf = 'high'
        else:
            conf = 'medium'
        return best, conf, 'gnis-exact', len(exact)

    # NWS truncates long names (e.g. "Chilchnbto" = Chilchinbito, "Bredsprngs" = Breadsprings):
    # accept GNIS names that start with the same letter and contain the NWS letters in order.
    communities = [g for g in pool if CLASS_RANK.get(g['class'], 20) <= CLASS_RANK['Locale']]
    sub = [g for g in communities if g['norm'][:1] == n[:1] and len(g['norm']) >= len(n) and is_subsequence(n, g['norm'])]
    if sub:
        ranked = sorted(sub, key=lambda g: (-difflib.SequenceMatcher(None, n, g['norm']).ratio(),
                                            CLASS_RANK.get(g['class'], 20),
                                            km((g['lat'], g['lon']), anchor) if anchor else 0))
        best = ranked[0]
        ratio = difflib.SequenceMatcher(None, n, best['norm']).ratio()
        conf = 'medium' if ratio >= 0.75 and len(ranked) == 1 else 'low'
        return best, conf, f'gnis-abbrev (ratio {ratio:.2f})', len(sub)

    close = difflib.get_close_matches(n, [g['norm'] for g in communities], n=3, cutoff=0.85)
    if close:
        cands = [g for g in communities if g['norm'] == close[0]]
        best = pick(cands, county, anchor)[0]
        return best, 'low', f'gnis-fuzzy ({close[0]})', len(cands)

    return None, None, None, 0


def geocode_alias_gnis(gnis_name, tab, group, gnis, anchor):
    state = expected_state(tab, group)
    cands = [g for g in gnis if g['state'] == state and g['name'].lower() == gnis_name.lower()]
    if not cands:
        return None, 0
    return pick(cands, expected_county(tab, group), anchor)[0], len(cands)


def geocode_osm(name, tab, group, query=None):
    state = 'New Mexico' if expected_state(tab, group) == 'NM' else 'Arizona'
    s, w, n, e = FGZ_BBOX
    params = {
        'q': query or f'{name}, {state}',
        'format': 'jsonv2',
        'countrycodes': 'us',
        'limit': 3,
        'viewbox': f'{w},{n},{e},{s}',
        'bounded': 1,
    }
    req = urllib.request.Request(f'{NOMINATIM_URL}?{urllib.parse.urlencode(params)}',
                                 headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        results = json.load(res)
    time.sleep(1.1)  # Nominatim usage policy: at most 1 request per second
    if not results:
        return None
    r = results[0]
    return {'lat': float(r['lat']), 'lon': float(r['lon']), 'display': r.get('display_name', ''),
            'osm': f"{r.get('osm_type', '')}/{r.get('osm_id', '')}", 'type': r.get('type', '')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gnis-dir', required=True)
    ap.add_argument('--review-dir', required=True)
    ap.add_argument('--repo', default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument('--no-osm', action='store_true')
    args = ap.parse_args()

    repo = Path(args.repo)
    out_places = repo / 'data' / 'snowtables' / 'fgz_places.json'
    overrides_path = repo / 'data' / 'snowtables' / 'fgz_places_overrides.json'
    review = Path(args.review_dir)
    review.mkdir(parents=True, exist_ok=True)

    tables = fetch_json(SNOWTABLES_URL)['snow_tables']
    prob = fetch_json(PROBSNOW_URL)['output'][0]['data']
    overrides = json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
    aliases_path = repo / 'data' / 'snowtables' / 'fgz_places_aliases.json'
    aliases = json.loads(aliases_path.read_text()) if aliases_path.exists() else {}
    gnis = load_gnis(args.gnis_dir)

    nws = {norm(k): (v['latitude'], v['longitude'], k) for k, v in prob.items()}

    # Every place (counties + tribal), remembering the first tab/group it appears in.
    places = {}
    for tab in ('counties', 'tribal'):
        for group, locs in tables[tab].items():
            for name in locs:
                places.setdefault(name, (tab, group))

    out = {}
    review_rows = []
    unresolved = []
    excluded = sorted((n, *places[n]) for n in places if aliases.get(n, {}).get('skip'))

    # Pass 1: manual + NWS coordinates (also used as anchors for each group).
    anchors = {}
    for name, (tab, group) in places.items():
        if name in overrides:
            o = overrides[name]
            out[name] = {'lat': o['lat'], 'lon': o['lon'], 'source': 'manual', 'ref': o.get('ref', ''), 'confidence': 'verified'}
        elif norm(name) in nws:
            lat, lon, nws_name = nws[norm(name)]
            out[name] = {'lat': lat, 'lon': lon, 'source': 'nws', 'ref': f'ProbSnow_WebData: {nws_name}', 'confidence': 'high'}
        if name in out:
            anchors.setdefault(group, []).append((out[name]['lat'], out[name]['lon']))

    def anchor_for(group):
        pts = anchors.get(group)
        if not pts:
            return None
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    # Pass 2: GNIS, then OSM, for everything else.
    for name, (tab, group) in sorted(places.items()):
        if name in out:
            continue
        alias = aliases.get(name)
        if alias and alias.get('skip'):
            continue
        if alias and alias.get('gnis'):
            best, ncand = geocode_alias_gnis(alias['gnis'], tab, group, gnis, anchor_for(group))
            if best:
                out[name] = {'lat': round(best['lat'], 5), 'lon': round(best['lon'], 5), 'source': 'gnis',
                             'ref': f"GNIS {best['id']} {best['name']} ({best['class']}, {best['county']} Co., {best['state']})",
                             'confidence': 'medium'}
                review_rows.append((name, tab, group, out[name], f"alias -> {alias['gnis']}: {alias.get('note', '')}", ncand))
                continue
        if alias and alias.get('osm') and not args.no_osm:
            hit = geocode_osm(name, tab, group, alias['osm'])
            if hit:
                out[name] = {'lat': round(hit['lat'], 5), 'lon': round(hit['lon'], 5), 'source': 'osm',
                             'ref': f"OSM {hit['osm']} {hit['display']}", 'confidence': 'low'}
                review_rows.append((name, tab, group, out[name], f"alias -> osm '{alias['osm']}' ({hit['type']}): {alias.get('note', '')}", 1))
                continue
        if alias:
            # An alias means the plain name is known to be misleading: never fall back
            # to generic matching (e.g. "San Juan" would become San Juan County).
            unresolved.append((name, tab, group))
            continue
        best, conf, method, ncand = geocode_gnis(name, tab, group, gnis, anchor_for(group))
        if best:
            out[name] = {'lat': round(best['lat'], 5), 'lon': round(best['lon'], 5), 'source': 'gnis',
                         'ref': f"GNIS {best['id']} {best['name']} ({best['class']}, {best['county']} Co., {best['state']})",
                         'confidence': conf}
            review_rows.append((name, tab, group, out[name], method, ncand))
            continue
        hit = None if args.no_osm else geocode_osm(name, tab, group)
        if hit:
            out[name] = {'lat': round(hit['lat'], 5), 'lon': round(hit['lon'], 5), 'source': 'osm',
                         'ref': f"OSM {hit['osm']} {hit['display']}", 'confidence': 'low'}
            review_rows.append((name, tab, group, out[name], f"osm ({hit['type']})", 1))
        else:
            unresolved.append((name, tab, group))

    out_places.parent.mkdir(parents=True, exist_ok=True)
    out_places.write_text(json.dumps(dict(sorted(out.items())), indent=2) + '\n')

    features = []
    for name, tab, group, rec, method, ncand in review_rows:
        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [rec['lon'], rec['lat']]},
            'properties': {
                'callsign': f"{name} ({rec['confidence']})",
                'name': name,
                'type': 'u-d-p',
                'marker-color': COLORS.get(rec['confidence'], '#999999'),
                'marker-opacity': 1,
                'remarks': f"Snow Tables: {group} ({tab})\nMatch: {rec['ref']}\nMethod: {method}; candidates: {ncand}; confidence: {rec['confidence']}",
                'snow_tab': tab,
                'snow_group': group,
                'source': rec['source'],
                'ref': rec['ref'],
                'confidence': rec['confidence'],
                'method': method,
            },
        })
    (review / 'fgz_places_review.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'features': features}, indent=2) + '\n')

    counts = {}
    for _, _, _, rec, _, _ in review_rows:
        counts[rec['confidence']] = counts.get(rec['confidence'], 0) + 1
    lines = [
        '# FGZ Snow Tables — geocoded places for review',
        '',
        f'- Places in Snow Tables (counties + tribal): **{len(places)}**',
        f"- From NWS coordinates (ProbSnow feed): **{sum(1 for r in out.values() if r['source'] == 'nws')}**",
        f"- Manual overrides: **{sum(1 for r in out.values() if r['source'] == 'manual')}**",
        f'- Geocoded for review: **{len(review_rows)}** ' + ', '.join(f'{k}: {v}' for k, v in sorted(counts.items())),
        f'- Unresolved: **{len(unresolved)}**',
        f'- Excluded on purpose (`"skip": true` in aliases): **{len(excluded)}**',
        '',
        'Import `fgz_places_review.geojson` into CloudTAK: green = high, orange = medium, red = low confidence.',
        'Fix anything wrong in `data/snowtables/fgz_places_overrides.json` as',
        '`{"<Snow Tables name>": {"lat": 0, "lon": 0, "ref": "how verified"}}` and re-run the script.',
        '',
        '| Snow Tables name | Group | Confidence | Method | Matched |',
        '|---|---|---|---|---|',
    ]
    order = {'low': 0, 'medium': 1, 'high': 2}
    for name, tab, group, rec, method, ncand in sorted(review_rows, key=lambda r: (order.get(r[3]['confidence'], 3), r[0])):
        lines.append(f"| {name} | {group} | {rec['confidence']} | {method} ({ncand}) | {rec['ref']} |")
    if unresolved:
        lines += ['', '## Unresolved (need a manual override)', '', '| Snow Tables name | Tab | Group |', '|---|---|---|']
        lines += [f'| {n} | {t} | {g} |' for n, t, g in unresolved]
    if excluded:
        lines += ['', '## Excluded on purpose (not mapped)', '', '| Snow Tables name | Tab | Group | Note |', '|---|---|---|---|']
        lines += [f"| {n} | {t} | {g} | {aliases[n].get('note', '')} |" for n, t, g in excluded]
    (review / 'fgz_places_review.md').write_text('\n'.join(lines) + '\n')

    print(f"places={len(places)} nws={sum(1 for r in out.values() if r['source'] == 'nws')} "
          f"geocoded={len(review_rows)} {counts} unresolved={len(unresolved)} excluded={len(excluded)}")


if __name__ == '__main__':
    main()
