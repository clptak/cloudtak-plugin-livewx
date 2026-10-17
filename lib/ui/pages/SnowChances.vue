<template>
    <section
        v-if='loc && win'
        class='ch'
    >
        <div class='ch-head'>
            <h4 class='ch-title'>
                Chances
            </h4>
            <select
                v-if='snowProbs.windows.length > 1'
                class='form-select form-select-sm ch-window'
                :value='windowIndex'
                aria-label='Storm window'
                @change='onWindow'
            >
                <option
                    v-for='(w, i) in snowProbs.windows'
                    :key='w.start'
                    :value='i'
                >
                    {{ windowLabel(w.start, w.end) }}
                </option>
            </select>
        </div>
        <p class='ch-hint'>
            {{ windowLabel(win.start, win.end) }} MST · NWS probabilistic forecast
        </p>

        <dl class='ch-dl'>
            <dt>Official forecast</dt>
            <dd>{{ amountText(loc.official) }}</dd>
            <template v-if='likely'>
                <dt>Most likely</dt>
                <dd>{{ likely.label }} <span class='ch-sub'>({{ likely.pct }}%)</span></dd>
            </template>
            <dt>Likely range</dt>
            <dd>
                {{ rangeText }} <span class='ch-sub'>(10th–90th percentile)</span>
            </dd>
            <dt>Snow begins</dt>
            <dd>{{ timing(loc.start) }}</dd>
            <dt>Most intense</dt>
            <dd>{{ timing(loc.peak) }}</dd>
            <dt>Snow ends</dt>
            <dd>{{ timing(loc.end) }}</dd>
        </dl>

        <p class='ch-sub mb-1'>
            Chance of at least
        </p>
        <div
            v-for='e in loc.exceed'
            :key='e.label'
            class='ch-bar-row'
        >
            <span class='ch-bar-label'>{{ e.label }}</span>
            <span
                class='ch-bar'
                role='img'
                :aria-label='`${e.label}: ${e.pct ?? 0}%`'
            >
                <span
                    class='ch-bar-fill'
                    :style='{ width: `${Math.max(0, Math.min(100, e.pct ?? 0))}%` }'
                />
            </span>
            <span class='ch-bar-pct'>{{ e.pct == null ? '—' : `${e.pct}%` }}</span>
        </div>

        <div class='ch-links'>
            <a
                :href='probPageUrl(loc.name)'
                target='_blank'
                rel='noopener noreferrer'
                @click.prevent='openProbPage'
            >Open snow forecast</a>
            <span
                v-if='updatedLine'
                class='ch-sub'
            >{{ updatedLine }}</span>
        </div>
    </section>
    <p
        v-else-if='showMissing'
        class='ch-sub mt-2'
    >
        No probabilistic forecast for this location.
    </p>
</template>

<script setup lang='ts'>
import { computed, ref, watch } from 'vue';
import { formatInTimeZone } from '../../core/timezone.ts';
import { openLinkWindow } from '../../layers/feature-popup.ts';
import {
    currentWindow,
    mostLikely,
    probFor,
    probPageUrl,
    snowProbs,
} from '../../snow/snow-probs.ts';
import { SNOW_TZ, amountText, rangeText as percentileRange } from '../../snow/snow-tables.ts';

const props = defineProps<{
    /** Snow Tables place name. */
    name: string;
    /** Show a note when the place has no probabilistic forecast. */
    showMissing?: boolean;
}>();

/** Selected storm window; -1 = the one in progress (or next). */
const windowIndex = ref(-1);

watch(() => snowProbs.fetchedAt, () => {
    if (windowIndex.value >= snowProbs.windows.length) windowIndex.value = -1;
});

const win = computed(() => {
    if (windowIndex.value >= 0) return snowProbs.windows[windowIndex.value] ?? null;
    return currentWindow(snowProbs.windows);
});

const loc = computed(() => probFor(win.value, props.name));
const likely = computed(() => (loc.value ? mostLikely(loc.value) : null));

const rangeText = computed(() => {
    const p = loc.value?.percentiles;
    return p ? percentileRange(p.p10, p.p90) : '—';
});

const updatedLine = computed(() => {
    if (snowProbs.updated == null) return '';
    return `NWS updated ${formatInTimeZone(snowProbs.updated, SNOW_TZ, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} MST`;
});

function fmt(t: number): string {
    return formatInTimeZone(t, SNOW_TZ, { weekday: 'short', hour: 'numeric' });
}

function windowLabel(start: number, end: number): string {
    return `${fmt(start)} – ${fmt(end)}`;
}

/** NWS shows timing as a ±1 hour window. */
function timing(t: number | null): string {
    if (t == null) return 'No snow expected';
    const hour = 3_600_000;
    return `${fmt(t - hour)} – ${formatInTimeZone(t + hour, SNOW_TZ, { hour: 'numeric' })}`;
}

function onWindow(e: Event): void {
    windowIndex.value = Number((e.target as HTMLSelectElement).value);
}

function openProbPage(): void {
    if (loc.value) openLinkWindow(probPageUrl(loc.value.name));
}
</script>

<style scoped>
.ch {
    margin-top: 0.85rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--livewx-border, var(--tblr-border-color, #333));
}
.ch-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}
.ch-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
}
.ch-window {
    width: auto;
    max-width: 60%;
}
.ch-hint {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.8rem;
    color: var(--tblr-secondary, inherit);
}
.ch-dl {
    display: grid;
    grid-template-columns: minmax(6.5rem, 40%) 1fr;
    gap: 0.25rem 0.65rem;
    margin: 0 0 0.65rem;
    font-size: 0.85rem;
}
.ch-dl dt {
    margin: 0;
    font-weight: 600;
    color: var(--tblr-secondary, inherit);
}
.ch-dl dd {
    margin: 0;
}
.ch-sub {
    font-size: 0.75rem;
    color: var(--tblr-secondary, inherit);
}
.ch-bar-row {
    display: grid;
    grid-template-columns: 3.6rem 1fr 2.6rem;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.2rem;
    font-size: 0.8rem;
}
.ch-bar {
    position: relative;
    height: 0.6rem;
    border-radius: 999px;
    background: var(--livewx-border, var(--tblr-border-color, #333));
    overflow: hidden;
}
.ch-bar-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: #4f94e5;
    border-radius: 999px;
}
.ch-bar-pct {
    text-align: right;
    font-variant-numeric: tabular-nums;
}
.ch-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
}
</style>
