/**
 * NWS Flagstaff (FGZ) Snow Forecast probabilities — Northern Arizona only.
 *
 * Reads the office's own feed behind weather.gov/fgz/snow-forecast (no
 * official API). Per location and storm window: the official amount, snow
 * timing, chance of at least N inches (exceedance), chance of each amount
 * band, and the 10th–90th percentile amounts. Locations carry NWS's own
 * coordinates.
 */
import { markRaw, reactive } from 'vue';
import { fetchJson } from '../core/egress.ts';

export const SNOW_PROB_URL = 'https://www.weather.gov/source/fgz/data/ProbSnow_WebData.json';
export const SNOW_PROB_PAGE = 'https://www.weather.gov/fgz/snow-forecast';
const CACHE_MS = 5 * 60_000;

/** Chance of at least N inches ("View Exceedance" on the NWS page). */
export const EXCEEDANCE: ReadonlyArray<{ key: string; label: string; inches: number }> = [
    { key: 'ProbSnowGETr', label: '≥ Trace', inches: 0 },
    { key: 'ProbSnowGE01', label: '≥ 1"', inches: 1 },
    { key: 'ProbSnowGE02', label: '≥ 2"', inches: 2 },
    { key: 'ProbSnowGE04', label: '≥ 4"', inches: 4 },
    { key: 'ProbSnowGE06', label: '≥ 6"', inches: 6 },
    { key: 'ProbSnowGE08', label: '≥ 8"', inches: 8 },
    { key: 'ProbSnowGE12', label: '≥ 12"', inches: 12 },
    { key: 'ProbSnowGE18', label: '≥ 18"', inches: 18 },
];

/** Chance of each amount band ("View Probabilities" on the NWS page). */
const BANDS: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'ProbSnowNone', label: 'None' },
    { key: 'ProbSnowGETr', label: '<1"' },
    { key: 'ProbSnowGE01', label: '1-2"' },
    { key: 'ProbSnowGE02', label: '2-4"' },
    { key: 'ProbSnowGE04', label: '4-6"' },
    { key: 'ProbSnowGE06', label: '6-8"' },
    { key: 'ProbSnowGE08', label: '8-12"' },
    { key: 'ProbSnowGE12', label: '≥12"' },
];

/** Exceedance thresholds offered for coloring the map. */
export const MAP_THRESHOLDS = [1, 2, 4, 6, 8, 12] as const;

export type SnowProbLocation = {
    name: string;
    area: string;
    lat: number;
    lon: number;
    official: number | null;
    start: number | null;
    peak: number | null;
    end: number | null;
    /** Percent chance of at least each EXCEEDANCE threshold (null if absent). */
    exceed: Array<{ label: string; inches: number; pct: number | null }>;
    bands: Array<{ label: string; pct: number | null }>;
    percentiles: { p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null };
};

export type SnowProbWindow = {
    start: number;
    end: number;
    locations: Record<string, SnowProbLocation>;
};

type RawLoc = {
    area?: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    data?: {
        snow_official?: number | null;
        snow_start?: string | null;
        snow_peak?: string | null;
        snow_end?: string | null;
        prob?: Record<string, number | null>;
        poe?: Record<string, number | null>;
        prcntl?: Record<string, number | null>;
    };
};

type Raw = {
    updated?: string;
    output?: Array<{ start?: string; end?: string; data?: Record<string, RawLoc> }>;
};

export const snowProbs = reactive({
    updated: null as number | null,
    windows: [] as SnowProbWindow[],
    fetchedAt: null as number | null,
    loading: false,
    error: '',
});

let inflight: Promise<void> | null = null;

function ms(raw: unknown): number | null {
    if (typeof raw !== 'string' || !raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

function num(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function normalizeLoc(key: string, r: RawLoc): SnowProbLocation | null {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (lat == null || lon == null) return null;
    const d = r.data ?? {};
    const pc = d.prcntl ?? {};
    return {
        name: r.location || key,
        area: r.area || '',
        lat,
        lon,
        official: num(d.snow_official),
        start: ms(d.snow_start),
        peak: ms(d.snow_peak),
        end: ms(d.snow_end),
        exceed: EXCEEDANCE.map((t) => ({ label: t.label, inches: t.inches, pct: num(d.poe?.[t.key]) })),
        bands: BANDS.map((b) => ({ label: b.label, pct: num(d.prob?.[b.key]) })),
        percentiles: {
            p10: num(pc.SnowAmt10Prcntl),
            p25: num(pc.SnowAmt25Prcntl),
            p50: num(pc.SnowAmt50Prcntl),
            p75: num(pc.SnowAmt75Prcntl),
            p90: num(pc.SnowAmt90Prcntl),
        },
    };
}

/** Load the FGZ probability feed (cached 5 min; keeps last good data on failure). */
export function loadSnowProbs(force = false): Promise<void> {
    if (!force && snowProbs.fetchedAt != null && Date.now() - snowProbs.fetchedAt < CACHE_MS) {
        return Promise.resolve();
    }
    if (inflight) return inflight;
    snowProbs.loading = true;
    inflight = (async () => {
        try {
            const raw = await fetchJson<Raw>(SNOW_PROB_URL);
            const windows: SnowProbWindow[] = [];
            for (const w of raw.output ?? []) {
                const start = ms(w.start);
                const end = ms(w.end);
                if (start == null || end == null) continue;
                const locations: Record<string, SnowProbLocation> = {};
                for (const [key, r] of Object.entries(w.data ?? {})) {
                    const loc = normalizeLoc(key, r);
                    if (loc) locations[loc.name] = loc;
                }
                windows.push({ start, end, locations });
            }
            if (!windows.length) throw new Error('Snow Forecast: no forecast windows');
            snowProbs.windows = markRaw(windows);
            snowProbs.updated = ms(raw.updated);
            snowProbs.fetchedAt = Date.now();
            snowProbs.error = '';
        } catch (e) {
            snowProbs.error = e instanceof Error ? e.message : 'Snow Forecast request failed';
        } finally {
            snowProbs.loading = false;
            inflight = null;
        }
    })();
    return inflight;
}

/** The window in progress, else the next one, else the first. */
export function currentWindow(windows: SnowProbWindow[], now = Date.now()): SnowProbWindow | null {
    return windows.find((w) => now >= w.start && now < w.end)
        ?? windows.find((w) => w.start >= now)
        ?? windows[0]
        ?? null;
}

/** Match Snow Tables and Snow Forecast names ("Flagstaff - Airport" ~ "Flagstaff Airport"). */
export function normName(s: string): string {
    return s.toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\bn\.?\s*m\.?$/, ' national monument')
        .replace(/\bn\.?\s*p\.?$/, ' national park')
        .replace(/\bmt\.?(?=\s|$)/g, 'mount')
        .replace(/\bst\.?(?=\s|$)/g, 'saint')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Snow Tables names that the Snow Forecast labels differently but are the same
 * place. Nearby-but-different places (e.g. Heber vs Heber-Overgaard) are left
 * out on purpose so a location never shows another place's probabilities.
 */
const PROB_ALIASES: Record<string, string> = {
    'GCNP - North Rim': 'Grand Canyon - North Rim',
    'GCNP - South Rim': 'Grand Canyon - South Rim',
    'Sunrise Ski Resort': 'Sunrise Park',
    'Mishongovi': 'Mishongnovi',
};

/** Probability record for a Snow Tables place name, if the Snow Forecast covers it. */
export function probFor(window: SnowProbWindow | null, name: string): SnowProbLocation | null {
    if (!window) return null;
    const exact = window.locations[PROB_ALIASES[name] ?? name];
    if (exact) return exact;
    const n = normName(name);
    return Object.values(window.locations).find((l) => normName(l.name) === n) ?? null;
}

/** Most likely amount band. */
export function mostLikely(loc: SnowProbLocation): { label: string; pct: number } | null {
    let best: { label: string; pct: number } | null = null;
    for (const b of loc.bands) {
        if (b.pct != null && (!best || b.pct > best.pct)) best = { label: b.label, pct: b.pct };
    }
    return best;
}

/** Percent chance of at least `inches` (exceedance), or null. */
export function chanceOfAtLeast(loc: SnowProbLocation, inches: number): number | null {
    return loc.exceed.find((e) => e.inches === inches)?.pct ?? null;
}

/** Deep link to the official Snow Forecast for a location. */
export function probPageUrl(name: string): string {
    return `${SNOW_PROB_PAGE}?${new URLSearchParams({ location: name }).toString()}`;
}
