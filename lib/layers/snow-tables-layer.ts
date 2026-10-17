/**
 * NWS Flagstaff Snow Tables locations on the map (Northern Arizona only).
 * Points in view, colored by their 72-hour total on the NWS scale; clicking one
 * shows its 12-hour periods. Uses the cached Snow Tables feed and the bundled
 * coordinate files — no extra requests per point.
 */
import { watch, type WatchStopHandle } from 'vue';
import type { FeatureCollection } from '../core/geojson.ts';
import { firstSymbolLayer, mapOf } from '../core/map-host.ts';
import type { LiveWxMap } from '../core/map-types.ts';
import { state } from '../core/state.ts';
import { formatInTimeZone } from '../core/timezone.ts';
import { coordFor, loadSnowCoords, pointForecastUrl, snowCoords } from '../snow/snow-locations.ts';
import {
    SNOW_TABS,
    SNOW_TZ,
    exactLabel,
    loadSnowTables,
    officialUrl,
    rangeLabel,
    seriesFor,
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
                const total = series ? twelveHourPeriods(table, series).total : null;
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
            rows.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(`${rangeLabel(p.inches)} (${exactLabel(p.inches)})`)}</dd>`);
        }
        rows.push(`<dt><strong>72-hour total</strong></dt><dd><strong>${escapeHtml(`${rangeLabel(total)} (${exactLabel(total)})`)}</strong></dd>`);
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
    if (!map.getLayer(CIRCLE_ID)) {
        map.addLayer({
            id: CIRCLE_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': ['match', ['get', 'kind'], 'road', 4, 6],
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 1,
                // NWS colors "<1"" white; give those a dark edge so they stay visible.
                'circle-stroke-color': ['case', ['==', ['get', 'color'], '#ffffff'], '#334155', '#ffffff'],
            },
        }, firstSymbolLayer(map));
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
    registerFeatureLayers([CIRCLE_ID], {
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
            unregisterFeatureLayers([CIRCLE_ID]);
            const map = mapOf();
            if (map) {
                removeLayerSafe(map, CIRCLE_ID);
                removeSourceSafe(map, SOURCE_ID);
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
            return `${featureCount} in view`;
        },
    });
}
