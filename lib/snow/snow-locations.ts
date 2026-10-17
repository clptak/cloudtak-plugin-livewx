/**
 * Coordinates for NWS Flagstaff Snow Tables locations (the feed has none).
 *
 * Built offline by scripts/snowtables/*.py into data/snowtables/:
 *   fgz_places.json     { "<place>": { lat, lon, source, ref, confidence } }
 *   fgz_mileposts.json  { "<road>": { "MP n": { lat, lon, elev_ft, source, ref, confidence } } }
 * Loaded on demand (separate chunk) the first time the snow map or page needs them.
 */
import { markRaw, reactive } from 'vue';
import type { SnowTabId } from './snow-tables.ts';

export type SnowCoord = {
    lat: number;
    lon: number;
    elevFt: number | null;
};

type RawCoord = { lat?: number; lon?: number; elev_ft?: number | null };

type Coords = {
    places: Record<string, SnowCoord>;
    mileposts: Record<string, Record<string, SnowCoord>>;
};

export const snowCoords = reactive({
    data: null as Coords | null,
    error: '',
});

let pending: Promise<void> | null = null;

function toCoord(raw: RawCoord | undefined): SnowCoord | null {
    if (!raw || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null;
    if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
    return {
        lat: raw.lat,
        lon: raw.lon,
        elevFt: typeof raw.elev_ft === 'number' ? raw.elev_ft : null,
    };
}

/** Load both coordinate files once; later calls reuse the result. */
export function loadSnowCoords(): Promise<void> {
    if (snowCoords.data) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
        try {
            const [placesMod, milepostsMod] = await Promise.all([
                import('../../data/snowtables/fgz_places.json'),
                import('../../data/snowtables/fgz_mileposts.json'),
            ]);
            const places: Coords['places'] = {};
            for (const [name, raw] of Object.entries(placesMod.default as Record<string, RawCoord>)) {
                const c = toCoord(raw);
                if (c) places[name] = c;
            }
            const mileposts: Coords['mileposts'] = {};
            const rawRoads = milepostsMod.default as Record<string, Record<string, RawCoord>>;
            for (const [road, posts] of Object.entries(rawRoads)) {
                mileposts[road] = {};
                for (const [mp, raw] of Object.entries(posts)) {
                    const c = toCoord(raw);
                    if (c) mileposts[road][mp] = c;
                }
            }
            snowCoords.data = markRaw({ places, mileposts });
            snowCoords.error = '';
        } catch (e) {
            snowCoords.error = e instanceof Error ? e.message : 'Snow location data failed to load';
        } finally {
            pending = null;
        }
    })();
    return pending;
}

/** Coordinates for a Snow Tables location, or null when it is not mapped. */
export function coordFor(tab: SnowTabId, group: string, name: string): SnowCoord | null {
    const data = snowCoords.data;
    if (!data) return null;
    if (tab === 'roadways') return data.mileposts[group]?.[name] ?? null;
    return data.places[name] ?? null;
}

/** NWS point forecast page for a location. */
export function pointForecastUrl(lat: number, lon: number): string {
    return `https://forecast.weather.gov/MapClick.php?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
}
