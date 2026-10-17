/**
 * NWS Flagstaff Snow Tables locations on the map (Northern Arizona only).
 * Points in view: a Tabler temperature-snow icon on a circle colored by the
 * 72-hour total (NWS scale), labelled with the current 12-hour period's amount
 * when that period has snow. Clicking one shows its 12-hour periods. Uses the
 * cached Snow Tables feed and the bundled coordinate files — no extra requests.
 */
import { watch, type WatchStopHandle } from 'vue';
import type { FeatureCollection } from '../core/geojson.ts';
import { firstSymbolLayer, mapOf } from '../core/map-host.ts';
import type { LiveWxMap } from '../core/map-types.ts';
import { state } from '../core/state.ts';
import { formatInTimeZone } from '../core/timezone.ts';
import { TEMP_SNOW_ICON_ID, ensureSnowIcons, removeSnowIcons } from '../snow/snow-icons.ts';
import { coordFor, loadSnowCoords, pointForecastUrl, snowCoords } from '../snow/snow-locations.ts';
import {
    SNOW_TABS,
    SNOW_TZ,
    amountText,
    exactLabel,
    loadSnowTables,
    officialUrl,
    seriesFor,
    showExact,
    snowColor,
    snowTables,
    twelveHourPeriods,
    type SnowTabId,
} from '../snow/snow-tables.ts';
import { escapeHtml, linkHtml, registerFeatureLayers, unregisterFeatureLayers } from './feature-popup.ts';
import {
    emptyFc,
    ensureGeoJsonSource,
    refreshStatus,
    registerLayer,
    removeLayerSafe,
    removeSourceSafe,
} from './registry.ts';

const LAYER_ID = 'snow_tables';
const SOURCE_ID = 'livewx-snow-src';
const CIRCLE_ID = 'livewx-snow-circle';
const SYMBOL_ID = 'livewx-snow-symbol';
const ICONS = [TEMP_SNOW_ICON_ID];
/** Locations with no snow in the next 72 hours. */
const NO_SNOW_COLOR = '#6c757d';

let running = false;
let data: FeatureCollection = emptyFc();
let featureCount = 0;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
let moveHandler: (() => void) | null = null;
let stopWatch: WatchStopHandle | null = null;

function inView(map: LiveWxMap, lat: number, lon: number): boolean {
    const b = map.getBounds?.();
    if (!b) return true;
    return lat >= b.getSouth() && lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();
}

function buildFeatures(map: LiveWxMap): FeatureCollection {
    const features: FeatureCollection['features'] = [];
    const table = snowTables.data;
    if (!table || !snowCoords.data) return { type: 'FeatureCollection', features };
    const seen = new Set<string>();
    for (const { id: tab } of SNOW_TABS) {
        if (tab === 'roadways' && !state.snowMapRoads) continue;
        for (const [group, locs] of Object.entries(table.tables[tab])) {
            for (const name of Object.keys(locs)) {
                // A place can be listed under a county and a tribe; plot it once.
                const key = tab === 'roadways' ? `${group}|${name}` : name;
                if (seen.has(key)) continue;
                const c = coordFor(tab, group, name);
                if (!c || !inView(map, c.lat, c.lon)) continue;
                seen.add(key);
                const series = seriesFor(table, tab, group, name);
                const periods = series ? twelveHourPeriods(table, series) : null;
                const total = periods?.total ?? null;
                const now = periods?.periods.find((x) => x.current)?.inches ?? null;
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
                    properties: {
                        tab,
                        group,
                        name,
                        lat: c.lat,
                        lon: c.lon,
                        elevFt: c.elevFt ?? '',
                        kind: tab === 'roadways' ? 'road' : 'place',
                        total: total ?? '',
                        color: snowColor(total) ?? NO_SNOW_COLOR,
                        // Current 12-hour period's amount; no label when it has no snow.
                        label: showExact(now) ? exactLabel(now) : '',
                    },
                });
            }
        }
    }
    return { type: 'FeatureCollection', features };
}

function title(tab: string, group: string, name: string): string {
    return tab === 'roadways' ? `${group} ${name}` : name;
}

/** Popup card: 12-hour periods for the next 72 hours, Arizona time. */
export function snowDetailHtml(props: Record<string, unknown>): string {
    const tab = String(props.tab || '') as SnowTabId;
    const group = String(props.group || '');
    const name = String(props.name || '');
    const lat = Number(props.lat);
    const lon = Number(props.lon);
    const table = snowTables.data;
    const series = table ? seriesFor(table, tab, group, name) : null;

    const rows: string[] = [];
    if (table && series) {
        const { periods, total } = twelveHourPeriods(table, series);
        for (const p of periods) {
            const fmt = (ms: number) => formatInTimeZone(ms, SNOW_TZ, { weekday: 'short', hour: 'numeric' });
            const label = `${fmt(p.start)} – ${fmt(p.end)}${p.current ? ' (now)' : ''}`;
            rows.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(amountText(p.inches))}</dd>`);
        }
        rows.push(`<dt><strong>72-hour total</strong></dt><dd><strong>${escapeHtml(amountText(total))}</strong></dd>`);
    } else {
        rows.push('<dt>Forecast</dt><dd>Not loaded</dd>');
    }
    const elev = Number(props.elevFt);
    if (Number.isFinite(elev) && elev > 0) {
        rows.push(`<dt>Elevation</dt><dd>${escapeHtml(`${Math.round(elev).toLocaleString()} ft`)}</dd>`);
    }
    const links = [linkHtml(officialUrl(tab, group), 'Snow table')];
    if (Number.isFinite(lat) && Number.isFinite(lon)) links.push(linkHtml(pointForecastUrl(lat, lon), 'Point forecast'));
    rows.push(`<dt>Links</dt><dd>${links.join(' · ')}</dd>`);

    return '<div class="livewx-alert-card">'
        + `<div class="livewx-alert-eyebrow">${escapeHtml(`Snow Tables · ${group}`)}</div>`
        + `<div class="livewx-alert-title">${escapeHtml(title(tab, group, name))}</div>`
        + `<dl class="livewx-alert-dl">${rows.join('')}</dl>`
        + '<div class="livewx-alert-eyebrow" style="margin-top:8px">NWS Flagstaff · MST</div></div>';
}

function paint(map: LiveWxMap): void {
    ensureGeoJsonSource(map, SOURCE_ID, data);
    // Style swaps drop images too, so re-add the icon every time.
    const icons = ensureSnowIcons(map, ICONS);
    if (!map.getLayer(CIRCLE_ID)) {
        map.addLayer({
            id: CIRCLE_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': ['match', ['get', 'kind'], 'road', 8, 11],
                'circle-opacity': 0.85,
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 1,
                // NWS colors "<1"" white; give those a dark edge so they stay visible.
                'circle-stroke-color': ['case', ['==', ['get', 'color'], '#ffffff'], '#334155', '#ffffff'],
            },
        }, firstSymbolLayer(map));
    }
    if (icons && !map.getLayer(SYMBOL_ID)) {
        map.addLayer({
            id: SYMBOL_ID,
            type: 'symbol',
            source: SOURCE_ID,
            layout: {
                'icon-image': TEMP_SNOW_ICON_ID,
                'icon-size': ['match', ['get', 'kind'], 'road', 0.75, 1],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'text-field': ['get', 'label'],
                'text-size': 12,
                'text-offset': [0, 1.35],
                'text-anchor': 'top',
                'text-optional': true,
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': '#0f172a',
                'text-halo-width': 1.5,
            },
        });
    }
}

/** Rebuild from the cached feed and coordinates (no fetch). */
function redraw(): void {
    const map = mapOf();
    if (!map || !running) return;
    data = buildFeatures(map);
    featureCount = data.features.length;
    paint(map);
    refreshStatus(LAYER_ID);
}

/** Refetch only if the shared cache is stale, then redraw. */
async function refresh(): Promise<void> {
    await Promise.all([loadSnowTables(), loadSnowCoords()]);
    redraw();
}

function bindMove(): void {
    const map = mapOf();
    if (!map || moveHandler) return;
    moveHandler = () => {
        if (moveTimer) clearTimeout(moveTimer);
        moveTimer = setTimeout(() => { void refresh(); }, 400);
    };
    map.on('moveend', moveHandler);
}

function unbindMove(): void {
    if (moveTimer) {
        clearTimeout(moveTimer);
        moveTimer = null;
    }
    const map = mapOf();
    if (map && moveHandler) {
        try { map.off('moveend', moveHandler); } catch { /* ignore */ }
    }
    moveHandler = null;
}

function registerPopup(): void {
    registerFeatureLayers([CIRCLE_ID, SYMBOL_ID], {
        label: 'Snow Tables',
        titleKeys: ['name'],
        detailHtml: snowDetailHtml,
    });
}

export function registerSnowTablesLayer(): void {
    registerLayer({
        id: LAYER_ID,
        group: 'more',
        label: 'Snow Tables (N. Arizona)',
        description: 'NWS Flagstaff 72-hour snowfall at Snow Tables locations',
        hosts: ['www.weather.gov'],
        sends: 'Nothing (Flagstaff feed, filtered locally)',
        start: async () => {
            running = true;
            registerPopup();
            bindMove();
            // Repaint when the feed reloads, coordinates arrive, or mileposts are toggled.
            stopWatch = watch(
                () => [snowTables.fetchedAt, snowCoords.data, state.snowMapRoads],
                () => redraw(),
            );
            await refresh();
        },
        stop: () => {
            running = false;
            stopWatch?.();
            stopWatch = null;
            unbindMove();
            unregisterFeatureLayers([CIRCLE_ID, SYMBOL_ID]);
            const map = mapOf();
            if (map) {
                removeLayerSafe(map, SYMBOL_ID);
                removeLayerSafe(map, CIRCLE_ID);
                removeSourceSafe(map, SOURCE_ID);
                removeSnowIcons(map, ICONS);
            }
            data = emptyFc();
            featureCount = 0;
        },
        restore: (map) => {
            if (!running) return;
            registerPopup();
            bindMove();
            paint(map);
        },
        status: () => {
            if (!running) return 'Off';
            if (snowTables.error && snowTables.fetchedAt == null) return snowTables.error;
            if (snowCoords.error) return snowCoords.error;
            if (snowTables.fetchedAt == null || !snowCoords.data) return 'Loading…';
            const snowing = data.features.filter((f) => f.properties?.label).length;
            return `${featureCount} in view · ${snowing} with snow this period`;
        },
    });
}
