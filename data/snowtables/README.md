# Snow Tables location data (Northern Arizona)

Coordinates for the locations in the **NWS Flagstaff (FGZ) Snow Tables**, used by the LiveWX *Snow Tables (N. Arizona)* map layer and the Snow Tables page (Zoom / Point forecast). The NWS feed lists locations by name only; these files supply where they are.

| File | Contents |
|---|---|
| `fgz_places.json` | Towns, communities and landmarks (Counties + Tribal tabs): `{ "<Snow Tables name>": { lat, lon, source, ref, confidence } }` |
| `fgz_mileposts.json` | Roadway mileposts (Roadways tab): `{ "<road>": { "MP <n>": { lat, lon, elev_ft, source, ref, confidence } } }` |
| `fgz_places_aliases.json` | NWS label → official/common name to search, or `"skip": true` to leave a place off the map |
| `fgz_places_overrides.json` | Hand-verified place coordinates — always win |
| `fgz_mileposts_overrides.json` | Hand-verified milepost coordinates — always win |

Keys must match the Snow Tables feed exactly (`https://www.weather.gov/source/fgz/snowtables/data/snowtable_data.json`).

## Decisions

1. **Northern Arizona only.** As of 2026-10-16, NWS Flagstaff is the only one of 123 NWS forecast offices that publishes Snow Tables, so there is no office selector.
2. **Unofficial source.** The tables come from FGZ's own JSON feed, not an official NWS API. The plugin reads it through the LiveWX proxy (`www.weather.gov` is allowlisted) and always links to the official page.
3. **12-hour periods, 72 hours only, Arizona time.** The page and map show one location at a time as six 12-hour periods (Day 5 AM–5 PM, Night 5 PM–5 AM MST, `America/Phoenix`) plus a 72-hour total. FGZ's tables are unreliable beyond 72 hours, so later periods are not shown.
4. **Place coordinates are geocoded, then reviewed by the maintainer.** Sources in order of trust: manual overrides → NWS's own lat/lon from the FGZ Snow Forecast feed → USGS GNIS (AZ/NM) → OpenStreetMap Nominatim (only where GNIS has nothing).
5. **Milepost coordinates come from ADOT** (`azgeo.az.gov/arcgis/rest/services/adot/Mileposts/MapServer/0`): active mainline posts only, cardinal-direction post preferred, with elevation.
6. **Three places are excluded from the map on purpose** (no reliable location): *Rim Top Trail* (Gila County), *San Juan* (Navajo Nation, NM), *Stoneman Lake Rd at Lake Mary Rd* (Coconino County). They still appear in the tables.
7. **Roadway mileposts are off by default** on the map (dense along I-40 / I-17 / US-89); *Include roadway mileposts* turns them on.
8. **Map colors follow the NWS Snow Tables scale.** No snow in 72 hours is gray; NWS's `<1"` color is white, drawn with a dark outline so it stays visible. Each Snow Tables point shows a Tabler `temperature-snow` icon on that circle (smaller on mileposts), labelled with the **current 12-hour period's** exact amount when that period has snow, and unlabelled otherwise.
9. **Amounts show the exact value only when it adds information**: `0"` and `Trace` stand alone; anything larger reads like `<1" (0.3")` or `2-4" (2.7")`. A 10th–90th percentile range of zero to zero reads `0"`.
10. **Probabilities come from a second FGZ feed** (`www.weather.gov/source/fgz/data/ProbSnow_WebData.json`, behind `weather.gov/fgz/snow-forecast`), also unofficial. It covers 106 locations with NWS's own coordinates: official amount, timing (shown as ±1 hour, like NWS), chance of at least trace … 18", amount bands, and 10th–90th percentile amounts, per storm window.
11. **Chances are matched to Snow Tables places by name** (normalized, e.g. `Flagstaff - Airport` = `Flagstaff Airport`) plus four explicit same-place aliases: `GCNP - North Rim` / `GCNP - South Rim` → `Grand Canyon - North/South Rim`, `Sunrise Ski Resort` → `Sunrise Park`, `Mishongovi` → `Mishongnovi`. Nearby-but-different places (e.g. `Heber` vs `Heber-Overgaard`, `Pinetop` / `Lakeside` vs `Pinetop-Lakeside`, `Prescott Courthouse` vs `Prescott Downtown`) are **not** matched, so a location never shows another place's probabilities.
12. **The Snow Chances map layer uses the probability feed's own 106 points**, colored by the chance of at least a selectable amount (1", 2", 4", 6", 8", 12"; default 1").
13. **Snow Chances icons and labels follow the most likely amount band.** A Tabler `snowflake` icon marks a location whose most likely band is not "None" (snow expected), with that band (e.g. `<1"`, `2-4"`, `12"+`) as its label; otherwise a `snowflake-off` icon with no label, to keep the map uncluttered. The circle color still shows the chance of at least the selected amount. `≥12"` is labelled `12"+` because the map label font may not include `≥`.

## Known limitations

- **Not every place has been verified.** 35 geocoded places are medium or low confidence (match details in each record's `ref`). Most uncertain:
  - Navajo-name aliases based on chapter names, not the data: *Bahast'lah* → Twin Lakes Chapter (NM), *Tolikan* → Sweetwater Chapter, *Tsah Bii Kin* → Inscription House Chapter.
  - *Hyde Peak* matched OpenStreetMap's "Hyde Creek Mountain".
  - Landmarks placed at a representative point (e.g. *Flagstaff - Mall*, *Canyon de Chelly N.M.*, *Walker Fire*).
- **SR 64 MP 240, 250, 260 are not on the map.** That stretch is Desert View Drive inside Grand Canyon National Park (Park Service–maintained); ADOT has no posts between MP 237 and MP 267.
- **Three mileposts are interpolated** between neighbouring ADOT posts: SR 89 MP 315, SR 89A MP 370, SR 89A MP 400.
- **Name drift.** If FGZ renames or adds a location, its table still works but it is not on the map until these files are regenerated (the page says "not on the map").
- **Probabilities cover 89 of 218 places**, and no roadway mileposts — the rest show "No probabilistic forecast for this location".
- **Probability-only locations.** 17 Snow Forecast locations (e.g. Camp Verde, Chino Valley, Village of Oak Creek) are not in the Snow Tables; they appear on the Snow Chances map but cannot be picked on the Snow Tables page.
- **Feed changes.** FGZ can change either feed's format or URL without notice; the page and map would then show an error and keep the last loaded data.

## Correcting or regenerating

Review files (not committed; written to `plans/snowtables/`) can be imported into CloudTAK: points are labelled with name and confidence and colored green / orange / red.

1. Put corrections in `fgz_places_overrides.json` — `{ "<name>": { "lat": 0, "lon": 0, "ref": "how verified" } }` — or `fgz_mileposts_overrides.json` — `{ "<road>": { "MP <n>": { "lat": 0, "lon": 0, "ref": "…" } } }`.
2. Regenerate:

   ```bash
   python3 -I scripts/snowtables/geocode_places.py --gnis-dir <folder with DomesticNames_AZ.txt and DomesticNames_NM.txt> --review-dir plans/snowtables
   python3 -I scripts/snowtables/build_mileposts.py --review-dir plans/snowtables
   ```

   GNIS files: `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/` (`DomesticNames_AZ_Text.zip`, `DomesticNames_NM_Text.zip`). Both scripts use only the Python standard library.

## Attribution

Map icons: [Tabler Icons](https://tabler.io/icons) `snowflake`, `snowflake-off`, `temperature-snow` (MIT License).
NWS Flagstaff (Snow Tables and Snow Forecast feeds), USGS Geographic Names Information System, ADOT milepost data (AZGeo), © OpenStreetMap contributors (ODbL) for the 11 places geocoded with Nominatim.
