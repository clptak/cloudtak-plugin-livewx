/**
 * NWS Flagstaff Snow Forecast probabilities on the map (Northern Arizona only).
 * Each of the feed's locations (NWS coordinates) is a circle colored by the
 * chance of at least the selected amount, with a snowflake icon when snow is
 * expected (most likely amount is not "None") or snowflake-off when it is not,
 * and the most likely amount as a label. Clicking one shows its Chances details.
 */
import { watch, type WatchStopHandle } from 'vue';
import type { FeatureCollection } from '../core/geojson.ts';
import { firstSymbolLayer, mapOf } from '../core/map-host.ts';
import type { LiveWxMap } from '../core/map-types.ts';
import { state } from '../core/state.ts';
import { formatInTimeZone } from '../core/timezone.ts';
import { SNOWFLAKE_ICON_ID, SNOWFLAKE_OFF_ICON_ID, ensureSnowIcons, removeSnowIcons } from '../snow/snow-icons.ts';
import { pointForecastUrl } from '../snow/snow-locations.ts';
import {
    chanceOfAtLeast,
    currentWindow,
    loadSnowProbs,
    mostLikely,
    probPageUrl,
    snowProbs,
} from '../snow/snow-probs.ts';
import { SNOW_TZ, exactLabel, rangeLabel } from '../snow/snow-tables.ts';
import { escapeHtml, linkHtml, registerFeatureLayers, unregisterFeatureLayers } from './feature-popup.ts';
import {
    emptyFc,
    ensureGeoJsonSource,
    refreshStatus,
    registerLayer,
    removeLayerSafe,
    removeSourceSafe,
} from './registry.ts';

const LAYER_ID = 'snow_chances';
const SOURCE_ID = 'livewx-snowprob-src';
const CIRCLE_ID = 'livewx-snowprob-circle';
const SYMBOL_ID = 'livewx-snowprob-symbol';

/** Probability bands for coloring (percent, lower bound). */
const PROB_COLORS: Array<{ min: number; color: string }> = [
    { min: 90, color: '#8d009d' },
    { min: 70, color: '#3066d6' },
    { min: 50, color: '#4f94e5' },
    { min: 30, color: '#7fb0ec' },
    { min: 10, color: '#a9c7f0' },
    { min: 1, color: '#dbe7f8' },
];
const ZERO_COLOR = '#6c757d';

let running = false;
let data: FeatureCollection = emptyFc();
let featureCount = 0;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
let moveHandler: (() => void) | null = null;
let stopWatch: WatchStopHandle | null = null;

function probColor(pct: number | null): string {
    if (pct == null || pct < 1) return ZERO_COLOR;
    return PROB_COLORS.find((c) => pct >= c.min)?.color ?? ZERO_COLOR;
}

function inView(map: LiveWxMap, lat: number, lon: number): boolean {
    const b = map.getBounds?.();
    if (!b) return true;
    return lat >= b.getSouth() && lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();
}

function buildFeatures(map: LiveWxMap): FeatureCollection {
    const features: FeatureCollection['features'] = [];
    const win = currentWindow(snowProbs.windows);
    if (!win) return { type: 'FeatureCollection', features };
    for (const loc of Object.values(win.locations)) {
        if (!inView(map, loc.lat, loc.lon)) continue;
        const pct = chanceOfAtLeast(loc, state.snowChanceInches);
        const likely = mostLikely(loc);
        const expected = Boolean(likely && likely.label !== 'None');
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [loc.lon, loc.lat] },
            properties: {
                name: loc.name,
                pct: pct ?? '',
                color: probColor(pct),
                expected,
                // Map label font may lack "≥", so "≥12"" is written "12"+".
                label: expected && likely ? likely.label.replace(/^≥\s*(.+)$/, '$1+') : '',
            },
        });
    }
    return { type: 'FeatureCollection', features };
}

function fmt(t: number): string {
    return formatInTimeZone(t, SNOW_TZ, { weekday: 'short', hour: 'numeric' });
}

function timing(t: number | null): string {
    if (t == null) return 'No snow expected';
    return `${fmt(t - 3_600_000)} – ${formatInTimeZone(t + 3_600_000, SNOW_TZ, { hour: 'numeric' })}`;
}

/** Popup card: official amount, likely range, timing, chance of at least N inches. */
export function snowChancesDetailHtml(props: Record<string, unknown>): string {
    const name = String(props.name || '');
    const win = currentWindow(snowProbs.windows);
    const loc = win?.locations[name];
    if (!win || !loc) {
        return `<div class="livewx-alert-card"><div class="livewx-alert-title">${escapeHtml(name)}</div>Forecast not loaded</div>`;
    }
    const likely = mostLikely(loc);
    const p = loc.percentiles;
    const rows: Array<[string, string]> = [
        ['Window', `${fmt(win.start)} – ${fmt(win.end)} MST`],
        ['Official', `${rangeLabel(loc.official)} (${exactLabel(loc.official)})`],
    ];
    if (likely) rows.push(['Most likely', `${likely.label} (${likely.pct}%)`]);
    if (p.p10 != null && p.p90 != null) rows.push(['Likely range', `${exactLabel(p.p10)} – ${exactLabel(p.p90)} (10th–90th %)`]);
    rows.push(['Snow begins', timing(loc.start)], ['Most intense', timing(loc.peak)], ['Snow ends', timing(loc.end)]);
    for (const e of loc.exceed) rows.push([`Chance ${e.label}`, e.pct == null ? '—' : `${e.pct}%`]);
    const dl = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    const links = [linkHtml(probPageUrl(loc.name), 'Snow forecast'), linkHtml(pointForecastUrl(loc.lat, loc.lon), 'Point forecast')];
    return '<div class="livewx-alert-card">'
        + `<div class="livewx-alert-eyebrow">${escapeHtml(`Snow Chances · ${loc.area}`)}</div>`
        + `<div class="livewx-alert-title">${escapeHtml(loc.name)}</div>`
        + `<dl class="livewx-alert-dl">${dl}<dt>Links</dt><dd>${links.join(' · ')}</dd></dl></div>`;
}

function paint(map: LiveWxMap): void {
    ensureGeoJsonSource(map, SOURCE_ID, data);
    // Style swaps drop images too, so re-add the icons every time.
    const icons = ensureSnowIcons(map);
    if (!map.getLayer(CIRCLE_ID)) {
        map.addLayer({
            id: CIRCLE_ID,
            type: 'circle',
            source: SOURCE_ID,
            paint: {
                'circle-radius': 11,
                'circle-color': ['get', 'color'],
                'circle-opacity': 0.85,
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#0f172a',
            },
        }, firstSymbolLayer(map));
    }
    if (icons && !map.getLayer(SYMBOL_ID)) {
        map.addLayer({
            id: SYMBOL_ID,
            type: 'symbol',
            source: SOURCE_ID,
            layout: {
                'icon-image': ['case', ['get', 'expected'], SNOWFLAKE_ICON_ID, SNOWFLAKE_OFF_ICON_ID],
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

function redraw(): void {
    const map = mapOf();
    if (!map || !running) return;
    data = buildFeatures(map);
    featureCount = data.features.length;
    paint(map);
    refreshStatus(LAYER_ID);
}

async function refresh(): Promise<void> {
    await loadSnowProbs();
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
        label: 'Snow Chances',
        titleKeys: ['name'],
        detailHtml: snowChancesDetailHtml,
    });
}

export function registerSnowChancesLayer(): void {
    registerLayer({
        id: LAYER_ID,
        group: 'more',
        label: 'Snow Chances (N. Arizona)',
        description: 'NWS Flagstaff probabilistic snowfall: chance of at least the selected amount',
        hosts: ['www.weather.gov'],
        sends: 'Nothing (Flagstaff feed, filtered locally)',
        start: async () => {
            running = true;
            registerPopup();
            bindMove();
            stopWatch = watch(
                () => [snowProbs.fetchedAt, state.snowChanceInches],
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
                removeSnowIcons(map);
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
            if (snowProbs.error && snowProbs.fetchedAt == null) return snowProbs.error;
            if (snowProbs.fetchedAt == null) return 'Loading…';
            const snowy = data.features.filter((f) => f.properties?.expected).length;
            return `${featureCount} in view · ${snowy} with snow expected · color = chance of ≥ ${state.snowChanceInches}"`;
        },
    });
}
