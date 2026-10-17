# Spot Forecasts: replacement data source

Status: implemented 2026-10-17 (NOAA SPOT Forecast Monitor service). Investigated 2026-10-17.

## Problem

`lib/spot/spot.ts` loads `https://spot.weather.gov/cms/api/1.0/requests?isArchived=false`
through `/api/livewx/proxy`. Since 2026-10-17 that returns
`401 Full authentication is required to access this resource`, so the Spot page list
and the Spot Forecasts map layer show "HTTP 401".

The only key in sight is the one the NWS front end ships in `spot.weather.gov/config/config.js`.
Using it from the plugin was ruled out, and nothing below uses it.

## 1. spot.weather.gov today (anonymous, no key)

| Request | Result |
|---|---|
| `/cms/api/1.0/requests?isArchived=false` | 401 |
| `/cms/api/1.0/requests`, `/requests?office.nativeSiteId=BOI&isArchived=false` | 401 |
| `/cms/api/1.0/offices`, `/options`, `/forecasts`, `/forecasts?page=1`, `/observations`, `/incidents`, `/` | 401 |
| `/`, `/new-request`, `/BOI`, `/forecasts/{id}` (HTML) | 200, the single-page-app shell |

Every `/cms/api/1.0/*` path the front end calls (taken from `js/app.*.js`) now needs the key.
**No public JSON endpoint is left on spot.weather.gov.**

The HTML pages still work for people. The app's router has
`/forecasts/:id(\d+\.?\d?)` (`singleForecast`), and `https://spot.weather.gov/forecasts/2623938`
renders the full forecast in a browser, because the NWS page calls its own API itself. So the
plugin's **Open forecast** link (`forecastUrl(id)`) and the **Request a Spot Forecast**
form link both keep working, as long as we still know the request number.

## 2. Candidate: api.weather.gov FWS text products

`GET https://api.weather.gov/products/types/FWS` returns the national list (700 entries,
about the last 7 days, 70 offices). Each entry has `id`, `issuingOffice` (`KPQR`),
`issuanceTime` and `productName` ("Suppression Forecast"). `/products/types/FWS/locations/{WFO}`
narrows the list to one office. You need `GET /products/{id}` to get the text.

Text layout, checked on 60 recent products:

```
Spot Forecast for Summit Fire...USFS WIF        <- project name ... agency (agency often missing)
National Weather Service Portland OR
809 AM PDT Sat Oct 17 2026
...forecast body...
$$
Forecaster...Robinson
Requested by...Grangeville Dispatch             <- often a person's name
Type of request...WILDFIRE                      <- WILDFIRE / PRESCRIBED / OTHER / ...
.TAG 2623938.0/MSO                              <- spot request number . update number / office
.DELDT 10/17/26
.FormatterVersion 2.0.0
.EMAIL idgvc@firenet.gov                        <- requester e-mail(s), 56 of 60 products
```

What can be parsed and how reliably:

| Field | Source | Reliability |
|---|---|---|
| Project name | `Spot Forecast for X` | 60/60 |
| Agency | text after `...` in that line | about 50/60, free text ("USFS", "us forest service", "OR-WSA") |
| Issuance time | list `issuanceTime` | 60/60 |
| Office | list `issuingOffice` / `.TAG .../MSO` | 60/60 |
| Request no. and update no. | `.TAG nnnnnnn.u/WFO` | 60/60 |
| Request type | `Type of request...` | 60/60 |
| **Lat/lon** | **none** | **0/60**: no coordinates, elevation or legal location in the text |
| Delivery time, pending status | none | FWS products are only *issued* forecasts; pending requests have no product |

Verdict: **not usable as the main source.** Without coordinates there is nothing to put on the
map, and the radius filter, Zoom and Add to Map all stop working. It would also take one
request per product (hundreds per refresh), and the text has requesters' names and e-mail
addresses that the plugin should not pull in or show. It is useful only as a cross-check (below).

## 3. Recommended: NOAA ArcGIS "SPOT Forecast Monitor" layer

`https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/nws_fire_weather_spot/MapServer/0`

The service description says "NWS Fire Weather Spot Web Services ... updated every 15 minutes".
It is public with no key and sends CORS headers. `mapservices.weather.noaa.gov` is already on
both allowlists (`lib/core/egress.ts` `ALLOWED_HOSTS` and `server/plugin-livewx.ts` `PROXY_ALLOW`),
so no proxy or server change is needed.

Query (one request, about 226 KB as GeoJSON, which is smaller than the old 730 KB list):

```
.../MapServer/0/query?where=1%3D1&outFields=*&f=geojson
```

Live sample on 2026-10-17 15:27Z: 414 point features, all with distinct ids. `idp_filedate`
was 15:13Z, so the data was about 14 minutes old. Delivery times run 2026-10-08 to 2026-10-24
(about the same window as the old `isArchived=false` list). There were 376 complete and 38 pending.
`maxRecordCount` is 2000.

Example feature:

```json
{ "snumunum": "2623938", "name": "Pollock Road", "type": "Fire 2026-10-17 07:00:00 AM MDT",
  "tid": "0", "lat": "45.312", "lon": "-116.3607",
  "rmade": "2026-10-17 06:44:41 AM MDT", "rfill": "2026-10-17 07:02:23 AM MDT",
  "stat": "C", "stattext": "Completed: 2026-10-17 07:02:23 AM MDT", "wfo": "MSO",
  "deliverdtg": "2026-10-17 07:00:00 AM MDT" }
```

Cross-check with FWS: the request numbers in the `.TAG` lines of all 60 sampled FWS products were
in the layer (60/60). For 2623938 the lat/lon matches the official forecast page
(45.312 / -116.3607), so `snumunum` is the Spot request number the forecast page uses.

### Field mapping to `SpotRequest`

| `SpotRequest` | New source | Notes |
|---|---|---|
| `id` | `snumunum` | Works with `forecastUrl()` and keeps `spotCotId()` (`livewx-spot-<id>`) stable |
| `projectName` | `name` | |
| `lat`, `lon` | geometry (or `lat`/`lon` strings) | |
| `office` | `wfo` | Already without the K/P prefix (`MSO`, `HFO`) |
| `incidentCategory` | `type` up to the date | Exactly `Fire`, `Search and Rescue`, `Hazardous Materials`, `Marine`, `Other`, the same as `SPOT_CATEGORIES`, so the Incident filter is unchanged |
| request type (new) | `tid` | `0` = Wildfire and `1` = Prescribed (checked against FWS "Type of request"); other codes fall back to the category |
| `actionStatus` | `stat` | `C` = complete (`rfill` is a time), `P` = pending (`rfill` = "Incomplete"). `P` also covers a pending *update* to an already-filled request |
| `submittedAt` | `rmade` | |
| `deliverAt` | `deliverdtg` | |
| `filledAt` | `rfill` | `null` when "Incomplete" |
| `timeZone` | abbreviation on the timestamps | e.g. PDT→America/Los_Angeles, MST→America/Phoenix, AKDT→America/Anchorage, HST→Pacific/Honolulu, AST→America/Puerto_Rico |
| `incidentName`, `agency`, `state`, `officeCity`, `update` | none | Lost (see below) |

Timestamp format: `YYYY-MM-DD HH:MM:SS AM|PM TZ`. **The hour is already 24-hour** (`13:00:03 PM`,
`00:00:03 AM`), so the AM/PM marker is ignored. Convert by applying the zone's fixed UTC offset
(PDT −7, MDT −6, MST −7, CDT −5, EDT −4, AKDT −8, HST −10, AST −4, plus the standard-time
names). An unknown abbreviation gives `null` and the row still shows.

### What the page and layer would show

Everything in the current UI stays: the official-form button and copy line, location picking,
Office / Show (office, radius, all) / Radius / Incident filters, Hide complete, Refresh and age,
the list with **Open forecast / Zoom / Add to Map**, the temporary Zoom marker, and the map layer
(points in view, popup, and the icon/status-ring styling on `feat/layer-icons`).

Row content changes:

- Title: `name`. Badge: **Complete** (green) or **Pending** (amber).
- Sub line: `Wildfire | Prescribed | <category> · MSO · 12 mi`. This replaces `incident · office · state`.
- Time line: `Deliver Oct 17, 7:00 AM MDT · Forecast issued 3 h ago`, or `· Awaiting forecast`.
- Popup: Type, Status, Office, Requested, Deliver, Filled, Open forecast. The Agency and Update rows go.
- Add to Map remarks: `name`, `type · office · status`, forecast link. The format is unchanged.
- Attribution and layer metadata: "NWS Spot Forecast Monitor via NOAA map services
  (mapservices.weather.noaa.gov)". Layer `hosts` becomes `['mapservices.weather.noaa.gov']`.

### What is lost

- **Detailed status.** Change requested, New observations and Feedback (the purple "other" tone) now
  show as Pending or Complete. `statusTone` keeps only complete and pending.
- **Update number** (Initial forecast / Update #n).
- **Agency, state, incident name** (separate from project name), and **office city** in the Office
  select, which would show `MSO` instead of `MSO — Missoula`. A small static WFO→city table could
  bring the city back; I'd leave it out for now.
- **Freshness.** Data lags up to about 15 minutes, versus live before. The client cache stays at 5 minutes.

### Risks

- The service is public but undocumented as an API. It could change or close like the
  Spot API did. On failure the existing behavior holds: the previous list is kept and the error
  is shown. Parsing is defensive, so features with bad coordinates or ids are skipped.
- `acclevel` and `acts` are null on every feature. Restricted requests may already be filtered out
  upstream. That is fine for a public read-only view.

### Not recommended

- Using the key from `config.js` (ruled out).
- FWS products as the main source (no coordinates, many requests, personal data).
- Matching FWS names to incident locations from other feeds such as WFIGS. Most spot requests are
  prescribed burns and events that are not in those feeds, and name matching is unreliable.
- An optional later addition: get the update number for a single row on demand from
  `api.weather.gov/products/types/FWS/locations/{WFO}` by matching the `.TAG` request number.
  This is not part of this change.

## Implementation plan (only after approval)

1. `lib/spot/spot.ts`: change `SPOT_API` to the MapServer query URL. Add a raw feature type,
   timestamp and zone parsing, and a `normalize` for the new fields. `actionStatus` becomes
   `'complete' | 'pending'` (with labels and tones to match), and `requestType` is added. Remove
   `agency`, `state`, `incidentName`, `officeCity` and `update`, or set them to empty and stop
   showing them. Keep `forecastUrl` and `officeUrl`.
2. `lib/ui/pages/SpotPage.vue`: change `subLine` and `timeLine` and the attribution text. The
   Office select falls back to the bare id.
3. `lib/layers/spot-requests.ts`: change the popup rows, `spotFeatureProps`, `hosts`,
   `description` and `sends`.
4. `lib/spot/spot-cot.ts`: change the remarks line.
5. Remove `spot.weather.gov` from `ALLOWED_HOSTS` and `PROXY_ALLOW`. Only links open there now,
   and those don't go through the proxy. Check this before removing it.
6. Check against CloudTAK v13.109: app lint, app vue-tsc, API lint, API tsc. Then load the Spot
   page and layer in CloudTAK and confirm the live list, filters, Zoom, Add to Map and Open forecast work.
