/**
 * NWS Flagstaff (FGZ) Snow Tables — Northern Arizona only.
 *
 * Reads the office's own feed (no official API): 6-hour snowfall in inches per
 * location, grouped by tab (counties / tribal / roadways) and group (county,
 * tribe, road). Shown here as 12-hour periods for one location, Arizona time,
 * over the next 72 hours (FGZ: longer periods are unreliable).
 */
import { markRaw, reactive } from 'vue';
import { fetchJson } from '../core/egress.ts';

export const SNOW_TABLES_URL = 'https://www.weather.gov/source/fgz/snowtables/data/snowtable_data.json';
export const SNOW_TABLES_PAGE = 'https://www.weather.gov/fgz/SnowTables';
/** Arizona: MST (UTC-7) all year, no DST. */
export const SNOW_TZ = 'America/Phoenix';
export const SNOW_CACHE_MS = 5 * 60_000;
export const SNOW_HOURS = 72;
const STEP_MS = 6 * 3_600_000;
const PERIOD_MS = 12 * 3_600_000;
/** Below this many inches but above zero is a trace (as on the NWS page). */
const TRACE = 0.05;

export type SnowTabId = 'counties' | 'tribal' | 'roadways';

export const SNOW_TABS: ReadonlyArray<{ id: SnowTabId; label: string }> = [
    { id: 'counties', label: 'Counties' },
    { id: 'tribal', label: 'Tribal' },
    { id: 'roadways', label: 'Roadways' },
];

type SnowTablesRaw = {
    created?: string;
    grid_times?: string[];
    snow_tables?: Record<string, Record<string, Record<string, unknown>>>;
};

export type SnowData = {
    created: number | null;
    /** Start of each 6-hour value, epoch ms. */
    times: number[];
    tables: Record<SnowTabId, Record<string, Record<string, Array<number | null>>>>;
};

export type SnowPeriod = {
    start: number;
    end: number;
    /** Sum of the two 6-hour values; null when both are missing. */
    inches: number | null;
    current: boolean;
};

export const snowTables = reactive({
    data: null as SnowData | null,
    fetchedAt: null as number | null,
    loading: false,
    error: '',
});

let inflight: Promise<void> | null = null;

function parseMs(raw: unknown): number | null {
    if (typeof raw !== 'string' || !raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

function normalize(raw: SnowTablesRaw): SnowData {
    const times = (raw.grid_times ?? []).map(parseMs);
    if (!times.length || times.some((t) => t == null)) throw new Error('Snow Tables: missing grid times');
    const tables = { counties: {}, tribal: {}, roadways: {} } as SnowData['tables'];
    for (const tab of SNOW_TABS) {
        const groups = raw.snow_tables?.[tab.id] ?? {};
        for (const [group, locs] of Object.entries(groups)) {
            const out: Record<string, Array<number | null>> = {};
            for (const [name, series] of Object.entries(locs ?? {})) {
                if (!Array.isArray(series)) continue;
                out[name] = series.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
            }
            tables[tab.id][group] = out;
        }
    }
    return { created: parseMs(raw.created), times: times as number[], tables };
}

/**
 * Load the FGZ feed (cached 5 min; concurrent callers share one request).
 * On failure the previous data is kept and `snowTables.error` is set.
 */
export function loadSnowTables(force = false): Promise<void> {
    if (!force && snowTables.fetchedAt != null && Date.now() - snowTables.fetchedAt < SNOW_CACHE_MS) {
        return Promise.resolve();
    }
    if (inflight) return inflight;
    snowTables.loading = true;
    inflight = (async () => {
        try {
            const raw = await fetchJson<SnowTablesRaw>(SNOW_TABLES_URL);
            snowTables.data = markRaw(normalize(raw));
            snowTables.fetchedAt = Date.now();
            snowTables.error = '';
        } catch (e) {
            snowTables.error = e instanceof Error ? e.message : 'Snow Tables request failed';
        } finally {
            snowTables.loading = false;
            inflight = null;
        }
    })();
    return inflight;
}

export function groupsFor(data: SnowData | null, tab: SnowTabId): string[] {
    return data ? Object.keys(data.tables[tab] ?? {}) : [];
}

export function locationsFor(data: SnowData | null, tab: SnowTabId, group: string): string[] {
    return data ? Object.keys(data.tables[tab]?.[group] ?? {}) : [];
}

export function seriesFor(
    data: SnowData | null,
    tab: SnowTabId,
    group: string,
    location: string,
): Array<number | null> | null {
    return data?.tables[tab]?.[group]?.[location] ?? null;
}

/**
 * 12-hour periods for one location over the next 72 hours, aligned to the
 * NWS grid (00Z / 12Z = 5 PM / 5 AM MST). The first period is the one in
 * progress.
 */
export function twelveHourPeriods(
    data: SnowData,
    series: Array<number | null>,
    now = Date.now(),
): { periods: SnowPeriod[]; total: number | null } {
    const byTime = new Map<number, number | null>();
    data.times.forEach((t, i) => byTime.set(t, series[i] ?? null));

    const first = Math.floor(now / PERIOD_MS) * PERIOD_MS;
    const periods: SnowPeriod[] = [];
    for (let start = first; start < first + SNOW_HOURS * 3_600_000; start += PERIOD_MS) {
        const a = byTime.get(start);
        const b = byTime.get(start + STEP_MS);
        const has = (a != null) || (b != null);
        periods.push({
            start,
            end: start + PERIOD_MS,
            inches: has ? (a ?? 0) + (b ?? 0) : null,
            current: now >= start && now < start + PERIOD_MS,
        });
    }
    const known = periods.filter((p) => p.inches != null);
    const total = known.length ? known.reduce((s, p) => s + (p.inches as number), 0) : null;
    return { periods, total };
}

const RANGES: Array<{ min: number; max?: number; label: string }> = [
    { min: 72, label: '>72"' },
    { min: 60, max: 72, label: '60-72"' },
    { min: 48, max: 60, label: '48-60"' },
    { min: 36, max: 48, label: '36-48"' },
    { min: 30, max: 36, label: '30-36"' },
    { min: 24, max: 30, label: '24-30"' },
    { min: 18, max: 24, label: '18-24"' },
    { min: 12, max: 18, label: '12-18"' },
    { min: 8, max: 12, label: '8-12"' },
    { min: 6, max: 8, label: '6-8"' },
    { min: 4, max: 6, label: '4-6"' },
    { min: 2, max: 4, label: '2-4"' },
    { min: 1, max: 2, label: '1-2"' },
    { min: TRACE, max: 1, label: '<1"' },
];

/** NWS Snow Tables range label ("<1"", "2-4"", "Trace", "0""). */
export function rangeLabel(inches: number | null): string {
    if (inches == null) return '—';
    if (inches > 0 && inches < TRACE) return 'Trace';
    const r = RANGES.find((x) => inches >= x.min && (x.max === undefined || inches < x.max));
    return r ? r.label : '0"';
}

/** Exact amount, as the NWS page prints it. */
export function exactLabel(inches: number | null): string {
    if (inches == null) return '—';
    if (inches > 0 && inches < TRACE) return 'Trace';
    return `${inches.toFixed(1)}"`;
}

/** True when the exact amount adds information beyond the range label (not for zero / trace). */
export function showExact(inches: number | null): boolean {
    return inches != null && inches >= TRACE;
}

/** Range label, plus the exact amount only when it adds information: '0"', 'Trace', '<1" (0.3")'. */
export function amountText(inches: number | null): string {
    if (!showExact(inches)) return rangeLabel(inches);
    return `${rangeLabel(inches)} (${exactLabel(inches)})`;
}

/** 10th–90th percentile range; '0"' when both ends are zero. */
export function rangeText(low: number | null, high: number | null): string {
    if (low == null || high == null) return '—';
    if (!showExact(high)) return rangeLabel(high);
    return `${exactLabel(low)} – ${exactLabel(high)}`;
}

const COLOR_SCALE: Array<{ threshold: number; color: string }> = [
    { threshold: 72, color: '#a870cf' },
    { threshold: 48, color: '#8d009d' },
    { threshold: 36, color: '#b30606' },
    { threshold: 24, color: '#d9441d' },
    { threshold: 18, color: '#f48600' },
    { threshold: 12, color: '#f7bc00' },
    { threshold: 8, color: '#fae602' },
    { threshold: 6, color: '#0866d6' },
    { threshold: 4, color: '#08429e' },
    { threshold: 3, color: '#3066d6' },
    { threshold: 2, color: '#4f94e5' },
    { threshold: 1, color: '#a9c7f0' },
    { threshold: 0, color: '#ffffff' },
];

/** NWS Snow Tables color for an amount; null for no snow (nothing to shade). */
export function snowColor(inches: number | null): string | null {
    if (inches == null || inches < TRACE) return null;
    return COLOR_SCALE.find((c) => inches >= c.threshold)?.color ?? null;
}

/** Deep link to the official table for a tab / group. */
export function officialUrl(tab: SnowTabId, group: string): string {
    const q = new URLSearchParams({ tab, location: group });
    return `${SNOW_TABLES_PAGE}?${q.toString()}`;
}
