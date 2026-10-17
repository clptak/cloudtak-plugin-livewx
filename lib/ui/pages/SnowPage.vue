<template>
    <div class='snow'>
        <p class='sn-hint mt-0'>
            Northern Arizona only — NWS Flagstaff forecast snowfall, in 12-hour periods (Arizona time, MST).
        </p>

        <section class='sn-block'>
            <div
                class='btn-group w-100'
                role='group'
                aria-label='Snow Tables tab'
            >
                <button
                    v-for='t in tabs'
                    :key='t.id'
                    class='btn btn-sm btn-outline-secondary'
                    :class='{ active: state.snowTab === t.id }'
                    type='button'
                    :aria-pressed='state.snowTab === t.id'
                    @click='onTab(t.id)'
                >
                    {{ t.label }}
                </button>
            </div>

            <div class='sn-fields'>
                <div class='sn-field'>
                    <label
                        class='sn-label'
                        for='livewx-snow-group'
                    >{{ groupLabel }}</label>
                    <select
                        id='livewx-snow-group'
                        class='form-select form-select-sm'
                        :value='state.snowGroup'
                        :disabled='!groups.length'
                        @change='onGroup'
                    >
                        <option
                            v-for='g in groups'
                            :key='g'
                            :value='g'
                        >
                            {{ g }}
                        </option>
                    </select>
                </div>
                <div class='sn-field'>
                    <label
                        class='sn-label'
                        for='livewx-snow-location'
                    >{{ state.snowTab === 'roadways' ? 'Milepost' : 'Location' }}</label>
                    <select
                        id='livewx-snow-location'
                        class='form-select form-select-sm'
                        :value='state.snowLocation'
                        :disabled='!locations.length'
                        @change='onLocation'
                    >
                        <option value=''>
                            Select…
                        </option>
                        <option
                            v-for='l in locations'
                            :key='l'
                            :value='l'
                        >
                            {{ l }}
                        </option>
                    </select>
                </div>
            </div>

            <div class='sn-refresh'>
                <button
                    class='btn btn-sm btn-outline-secondary'
                    type='button'
                    :disabled='snowTables.loading'
                    @click='reload'
                >
                    Refresh
                </button>
                <span class='sn-age'>{{ ageLine }}</span>
            </div>
            <p
                v-if='errorLine'
                class='text-danger small mb-0 mt-2'
            >
                {{ errorLine }}
            </p>
        </section>

        <section
            v-if='table'
            class='sn-table-block'
        >
            <h4 class='sn-title'>
                {{ state.snowLocation }}
            </h4>
            <p class='sn-hint mt-0 mb-2'>
                {{ state.snowGroup }} · next 72 hours
            </p>
            <table class='table table-sm sn-table mb-2'>
                <thead>
                    <tr>
                        <th scope='col'>
                            Period (MST)
                        </th>
                        <th
                            scope='col'
                            class='text-end'
                        >
                            Snow
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for='p in table.periods'
                        :key='p.start'
                        :class='{ "sn-now": p.current }'
                    >
                        <td>
                            <div class='sn-period'>
                                {{ periodLabel(p.start, p.end) }}
                                <span
                                    v-if='p.current'
                                    class='sn-now-badge'
                                >now</span>
                            </div>
                            <div class='sn-sub'>
                                {{ dayOrNight(p.start) }}
                            </div>
                        </td>
                        <td class='text-end'>
                            <span class='sn-amount'>
                                <span
                                    class='sn-swatch'
                                    :style='swatchStyle(p.inches)'
                                    aria-hidden='true'
                                />
                                {{ rangeLabel(p.inches) }}
                            </span>
                            <div class='sn-sub'>
                                {{ exactLabel(p.inches) }}
                            </div>
                        </td>
                    </tr>
                </tbody>
                <tfoot>
                    <tr class='sn-total'>
                        <th scope='row'>
                            72-hour total
                        </th>
                        <td class='text-end'>
                            <span class='sn-amount'>
                                <span
                                    class='sn-swatch'
                                    :style='swatchStyle(table.total)'
                                    aria-hidden='true'
                                />
                                {{ rangeLabel(table.total) }}
                            </span>
                            <div class='sn-sub'>
                                {{ exactLabel(table.total) }}
                            </div>
                        </td>
                    </tr>
                </tfoot>
            </table>
            <p
                v-if='issuedLine'
                class='sn-hint mt-0'
            >
                {{ issuedLine }}
            </p>
        </section>

        <p
            v-else-if='snowTables.data && state.snowGroup'
            class='sn-hint'
        >
            Select a {{ state.snowTab === 'roadways' ? 'milepost' : 'location' }} to see its 12-hour snowfall.
        </p>

        <div class='sn-links'>
            <a
                v-if='state.snowGroup'
                :href='officialUrl(state.snowTab, state.snowGroup)'
                target='_blank'
                rel='noopener noreferrer'
                @click.prevent='openOfficial'
            >Open on weather.gov</a>
        </div>

        <p class='sn-attr'>
            Snow amounts from the NWS Flagstaff Snow Tables (weather.gov/fgz). Forecasts beyond 72 hours are not shown.
        </p>
    </div>
</template>

<script setup lang='ts'>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ageLabelMs } from '../../core/egress.ts';
import { setSnowSelection, state, type SnowTab } from '../../core/state.ts';
import { formatInTimeZone } from '../../core/timezone.ts';
import { openLinkWindow } from '../../layers/feature-popup.ts';
import {
    SNOW_TABS,
    SNOW_TZ,
    exactLabel,
    groupsFor,
    loadSnowTables,
    locationsFor,
    officialUrl,
    rangeLabel,
    seriesFor,
    snowColor,
    snowTables,
    twelveHourPeriods,
} from '../../snow/snow-tables.ts';

const TICK_MS = 30_000;
const tabs = SNOW_TABS;

/** Ticks so the "now" period and age labels stay current; also re-checks the cache. */
const now = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
    void loadSnowTables();
    tickTimer = setInterval(() => {
        now.value = Date.now();
        void loadSnowTables();
    }, TICK_MS);
});

onUnmounted(() => {
    if (tickTimer != null) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
});

const groupLabel = computed(() => {
    if (state.snowTab === 'roadways') return 'Road';
    if (state.snowTab === 'tribal') return 'Tribe';
    return 'County';
});

const groups = computed(() => groupsFor(snowTables.data, state.snowTab));
const locations = computed(() => locationsFor(snowTables.data, state.snowTab, state.snowGroup));

// Keep the saved selection valid against the live feed (FGZ can rename or drop entries).
watch([groups, locations], () => {
    if (!snowTables.data) return;
    if (!groups.value.includes(state.snowGroup)) {
        if (groups.value.length) setSnowSelection({ group: groups.value[0] });
        return;
    }
    if (state.snowLocation && !locations.value.includes(state.snowLocation)) {
        setSnowSelection({ location: '' });
    }
}, { immediate: true });

const table = computed(() => {
    const data = snowTables.data;
    if (!data || !state.snowLocation) return null;
    const series = seriesFor(data, state.snowTab, state.snowGroup, state.snowLocation);
    if (!series) return null;
    return twelveHourPeriods(data, series, now.value);
});

const ageLine = computed(() => {
    void now.value;
    if (snowTables.loading) return 'Loading…';
    if (snowTables.fetchedAt == null) return 'Not loaded';
    return `Updated ${ageLabelMs(snowTables.fetchedAt)}`;
});

const errorLine = computed(() => {
    void now.value;
    if (!snowTables.error) return '';
    if (snowTables.fetchedAt == null) return snowTables.error;
    return `Refresh failed (${snowTables.error}) — showing data from ${ageLabelMs(snowTables.fetchedAt)}.`;
});

const issuedLine = computed(() => {
    const created = snowTables.data?.created;
    if (created == null) return '';
    return `NWS data generated ${formatInTimeZone(created, SNOW_TZ, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    })} MST`;
});

function fmt(ms: number): string {
    return formatInTimeZone(ms, SNOW_TZ, { weekday: 'short', hour: 'numeric' });
}

function periodLabel(start: number, end: number): string {
    return `${fmt(start)} – ${fmt(end)}`;
}

function dayOrNight(start: number): string {
    const hour = Number(formatInTimeZone(start, SNOW_TZ, { hour: 'numeric', hour12: false }));
    return hour >= 5 && hour < 17 ? 'Day' : 'Night';
}

function swatchStyle(inches: number | null): Record<string, string> {
    const color = snowColor(inches);
    return color ? { background: color } : { background: 'transparent', borderStyle: 'dashed' };
}

function onTab(tab: SnowTab): void {
    setSnowSelection({ tab });
}

function onGroup(e: Event): void {
    setSnowSelection({ group: (e.target as HTMLSelectElement).value });
}

function onLocation(e: Event): void {
    setSnowSelection({ location: (e.target as HTMLSelectElement).value });
}

function reload(): void {
    void loadSnowTables(true);
}

function openOfficial(): void {
    if (state.snowGroup) openLinkWindow(officialUrl(state.snowTab, state.snowGroup));
}
</script>

<style scoped>
.snow {
    display: flex;
    flex-direction: column;
}
.sn-block {
    padding: 0 0 0.85rem;
    margin-bottom: 0.85rem;
    border-bottom: 1px solid var(--livewx-border, var(--tblr-border-color, #333));
}
.sn-hint {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--tblr-secondary, inherit);
}
.sn-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.65rem 0.75rem;
    margin-top: 0.65rem;
}
.sn-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
}
.sn-label {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
}
.sn-refresh {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.65rem;
}
.sn-age {
    font-size: 0.8rem;
    color: var(--tblr-secondary, inherit);
}
.sn-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
}
.sn-table {
    color: inherit;
    background: transparent;
    --tblr-table-bg: transparent;
    --bs-table-bg: transparent;
}
.sn-table th,
.sn-table td {
    vertical-align: middle;
    background: transparent;
    color: inherit;
}
.sn-period {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.sn-sub {
    font-size: 0.75rem;
    color: var(--tblr-secondary, inherit);
}
.sn-now td {
    font-weight: 600;
}
.sn-now-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0 0.35rem;
    border-radius: 999px;
    border: 1px solid currentColor;
}
.sn-amount {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
}
.sn-swatch {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 2px;
    border: 1px solid var(--livewx-border, var(--tblr-border-color, #555));
}
.sn-total th,
.sn-total td {
    border-top: 2px solid var(--livewx-border, var(--tblr-border-color, #333));
    font-weight: 700;
}
.sn-links {
    margin-top: 0.5rem;
    font-size: 0.85rem;
}
.sn-attr {
    margin: 0.85rem 0 0;
    font-size: 0.75rem;
    color: var(--tblr-secondary, inherit);
}
</style>
