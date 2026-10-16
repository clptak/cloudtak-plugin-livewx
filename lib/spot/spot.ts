/**
 * NWS Spot Forecast Monitor (spot.weather.gov) — read-only.
 *
 * Only the unauthenticated national list of active requests is used. Office
 * filtering and forecast/detail endpoints need an API key, so filtering is
 * done here and forecasts are opened on the official site instead.
 */
import { markRaw, reactive } from 'vue';
import { fetchJson, roundCoord, TtlCache } from '../core/egress.ts';

export const SPOT_API = 'https://spot.weather.gov/cms/api/1.0';
export const SPOT_SITE = 'https://spot.weather.gov';
export const NEW_REQUEST_URL = `${SPOT_SITE}/new-request`;
/** Reuse the national list for this long before refetching (~730 KB). */
export const SPOT_CACHE_MS = 5 * 60_000;

export const SPOT_RADII_MI = [25, 50, 100, 250] as const;
export const SPOT_CATEGORIES = [
    'Fire',
    'Search and Rescue',
    'Hazardous Materials',
    'Marine',
    'Other',
] as const;

export type SpotScope = 'office' | 'radius' | 'all';

/** Subset of a /cms/api/1.0/requests item. */
type SpotRequestRaw = {
    id?: string | number;
    projectName?: string;
    requesterAgency?: string;
    latitude?: number;
    longitude?: number;
    state?: string;
    incident?: { name?: string; category?: string };
    office?: { nativeSiteId?: string; city?: string };
    actionStatus?: string;
    submittedAt?: string;
    deliverAt?: string;
    isArchived?: boolean;
    spotForecasts?: Array<{ update_number?: number; request_filled_at?: string }>;
    Timezone?: { IANA?: string };
};

export type SpotRequest = {
    id: string;
    projectName: string;
    agency: string;
    lat: number;
    lon: number;
    state: string;
    incidentName: string;
    incidentCategory: string;
    office: string;
    officeCity: string;
    actionStatus: string;
    submittedAt: number | null;
    deliverAt: number | null;
    timeZone: string;
    /** Latest issued forecast update, if any. */
    update: number | null;
    filledAt: number | null;
};

export type SpotFilter = {
    scope: SpotScope;
    office: string;
    radiusMi: number;
    lat: number | null;
    lon: number | null;
    /** '' = all categories. */
    category: string;
    hideComplete: boolean;
};

export type SpotRow = SpotRequest & { distanceMi: number | null };

export const spot = reactive({
    requests: [] as SpotRequest[],
    fetchedAt: null as number | null,
    loading: false,
    error: '',
    /** Office (CWA) for the shared query point, from api.weather.gov/points. */
    autoOffice: '',
});

let inflight: Promise<void> | null = null;
const officeCache = new TtlCache<string>(24 * 60 * 60_000);

function parseMs(raw: unknown): number | null {
    if (typeof raw !== 'string' || !raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

function normalize(r: SpotRequestRaw): SpotRequest | null {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const office = String(r.office?.nativeSiteId || '').toUpperCase();
    if (r.id == null || !Number.isFinite(lat) || !Number.isFinite(lon) || !office) return null;
    if (r.isArchived) return null;
    let update: number | null = null;
    let filledAt: number | null = null;
    for (const f of r.spotForecasts ?? []) {
        const n = Number(f.update_number);
        if (Number.isFinite(n) && (update == null || n >= update)) {
            update = n;
            filledAt = parseMs(f.request_filled_at);
        }
    }
    return {
        id: String(r.id),
        projectName: String(r.projectName || 'Unnamed request').trim(),
        agency: String(r.requesterAgency || ''),
        lat,
        lon,
        state: String(r.state || ''),
        incidentName: String(r.incident?.name || ''),
        incidentCategory: String(r.incident?.category || ''),
        office,
        officeCity: String(r.office?.city || ''),
        actionStatus: String(r.actionStatus || ''),
        submittedAt: parseMs(r.submittedAt),
        deliverAt: parseMs(r.deliverAt),
        timeZone: String(r.Timezone?.IANA || ''),
        update,
        filledAt,
    };
}

/**
 * Load the national list of active requests. Reuses the cached list while it
 * is fresh unless `force`; concurrent callers share one request. On failure
 * the previous list is kept and `spot.error` is set.
 */
export function loadSpotRequests(force = false): Promise<void> {
    if (!force && spot.fetchedAt != null && Date.now() - spot.fetchedAt < SPOT_CACHE_MS) {
        return Promise.resolve();
    }
    if (inflight) return inflight;
    spot.loading = true;
    inflight = (async () => {
        try {
            const raw = await fetchJson<unknown>(`${SPOT_API}/requests?isArchived=false`);
            if (!Array.isArray(raw)) throw new Error('Unexpected Spot Monitor response');
            const list: SpotRequest[] = [];
            for (const item of raw as SpotRequestRaw[]) {
                const n = normalize(item);
                if (n) list.push(n);
            }
            // The list is replaced wholesale; no need for deep reactivity.
            spot.requests = markRaw(list);
            spot.fetchedAt = Date.now();
            spot.error = '';
        } catch (e) {
            spot.error = e instanceof Error ? e.message : 'Spot Monitor request failed';
        } finally {
            spot.loading = false;
            inflight = null;
        }
    })();
    return inflight;
}

/** NWS office (CWA) responsible for a point, or '' if unknown. */
export async function officeForPoint(lat: number, lon: number): Promise<string> {
    const key = `${roundCoord(lat)},${roundCoord(lon)}`;
    const hit = officeCache.get(key);
    if (hit != null) return hit;
    const body = await fetchJson<{ properties?: { cwa?: string } }>(
        `https://api.weather.gov/points/${key}`,
    );
    const cwa = String(body.properties?.cwa || '').toUpperCase();
    officeCache.set(key, cwa);
    return cwa;
}

/** Resolve `spot.autoOffice` for the given point; clears it when there is none. */
export async function refreshAutoOffice(lat: number | null, lon: number | null): Promise<void> {
    if (lat == null || lon == null) {
        spot.autoOffice = '';
        return;
    }
    try {
        spot.autoOffice = await officeForPoint(lat, lon);
    } catch {
        // Keep the previous value; the office select still works.
    }
}

export function isComplete(r: SpotRequest): boolean {
    return r.actionStatus === 'ST_COMPLETE';
}

const STATUS_LABELS: Record<string, string> = {
    ST_COMPLETE: 'Complete',
    ST_STARTRQST: 'Requested',
    ST_CHANGERQST: 'Change requested',
    AS_NEWOBS: 'New observations',
    AS_FEEDBACK: 'Feedback',
};

export function statusLabel(actionStatus: string): string {
    return STATUS_LABELS[actionStatus] || actionStatus || 'Unknown';
}

/** Badge tone: complete, awaiting a forecast, or another open action. */
export function statusTone(actionStatus: string): 'complete' | 'pending' | 'other' {
    if (actionStatus === 'ST_COMPLETE') return 'complete';
    if (actionStatus === 'ST_STARTRQST') return 'pending';
    return 'other';
}

export function forecastUrl(id: string): string {
    return `${SPOT_SITE}/forecasts/${encodeURIComponent(id)}`;
}

export function officeUrl(office: string): string {
    return `${SPOT_SITE}/${encodeURIComponent(office.toUpperCase())}`;
}

/** Great-circle distance in statute miles. */
export function distanceMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3958.8;
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Requests matching the category / hide-complete filters (no location scope). */
export function matchesContent(r: SpotRequest, category: string, hideComplete: boolean): boolean {
    if (hideComplete && isComplete(r)) return false;
    if (category && r.incidentCategory !== category) return false;
    return true;
}

/** Apply the Spot page filters; sorted by distance for radius scope, else newest delivery first. */
export function filterSpotRequests(list: SpotRequest[], f: SpotFilter): SpotRow[] {
    const hasPoint = f.lat != null && f.lon != null;
    const office = f.office.toUpperCase();
    const rows: SpotRow[] = [];
    for (const r of list) {
        if (!matchesContent(r, f.category, f.hideComplete)) continue;
        const d = hasPoint ? distanceMi(f.lat as number, f.lon as number, r.lat, r.lon) : null;
        if (f.scope === 'office' && r.office !== office) continue;
        if (f.scope === 'radius' && (d == null || d > f.radiusMi)) continue;
        rows.push({ ...r, distanceMi: d });
    }
    if (f.scope === 'radius') {
        rows.sort((a, b) => (a.distanceMi ?? 0) - (b.distanceMi ?? 0));
    } else {
        rows.sort((a, b) => (b.deliverAt ?? 0) - (a.deliverAt ?? 0));
    }
    return rows;
}

/** Offices present in the list, sorted, as `{ id, city }`. */
export function listOffices(list: SpotRequest[]): Array<{ id: string; city: string }> {
    const seen = new Map<string, string>();
    for (const r of list) {
        if (!seen.has(r.office)) seen.set(r.office, r.officeCity);
    }
    return [...seen.entries()]
        .map(([id, city]) => ({ id, city }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
