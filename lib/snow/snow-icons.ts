/**
 * Snow map icons for the Snow Chances and Snow Tables layers, drawn into
 * MapLibre images.
 *
 * Paths are Tabler Icons "snowflake", "snowflake-off" and "temperature-snow"
 * (outline, v3.49, https://tabler.io/icons — MIT License, © Paweł Kuna). Drawn
 * white with a dark outline (shared drawing in core/map-icons.ts) so they read
 * on any basemap and colored circle.
 */
import { ensureMapIcons, removeMapIcons, type MapIcon } from '../core/map-icons.ts';
import type { LiveWxMap } from '../core/map-types.ts';

export const SNOWFLAKE_ICON_ID = 'livewx-snowflake';
export const SNOWFLAKE_OFF_ICON_ID = 'livewx-snowflake-off';
export const TEMP_SNOW_ICON_ID = 'livewx-temperature-snow';

const SNOWFLAKE = [
    'M10 4l2 1l2 -1',
    'M12 2v6.5l3 1.72',
    'M17.928 6.268l.134 2.232l1.866 1.232',
    'M20.66 7l-5.629 3.25l.01 3.458',
    'M19.928 14.268l-1.866 1.232l-.134 2.232',
    'M20.66 17l-5.629 -3.25l-2.99 1.738',
    'M14 20l-2 -1l-2 1',
    'M12 22v-6.5l-3 -1.72',
    'M6.072 17.732l-.134 -2.232l-1.866 -1.232',
    'M3.34 17l5.629 -3.25l-.01 -3.458',
    'M4.072 9.732l1.866 -1.232l.134 -2.232',
    'M3.34 7l5.629 3.25l2.99 -1.738',
];

const SNOWFLAKE_OFF = [
    'M10 4l2 1l2 -1',
    'M12 2v6m1.196 1.186l1.804 1.034',
    'M17.928 6.268l.134 2.232l1.866 1.232',
    'M20.66 7l-5.629 3.25l-.031 .75',
    'M19.928 14.268l-1.015 .67',
    'M14.212 14.226l-2.171 1.262',
    'M14 20l-2 -1l-2 1',
    'M12 22v-6.5l-3 -1.72',
    'M6.072 17.732l-.134 -2.232l-1.866 -1.232',
    'M3.34 17l5.629 -3.25l-.01 -3.458',
    'M4.072 9.732l1.866 -1.232l.134 -2.232',
    'M3.34 7l5.629 3.25l.802 -.466',
    'M3 3l18 18',
];

const TEMPERATURE_SNOW = [
    'M4 13.5a4 4 0 1 0 4 0v-8.5a2 2 0 1 0 -4 0v8.5',
    'M4 9h4',
    'M14.75 4l1 2h2.25',
    'M17 4l-3 5l2 3',
    'M20.25 10l-1.25 2l1.25 2',
    'M22 12h-6l-2 3',
    'M18 18h-2.25l-1 2',
    'M17 20l-3 -5h-1',
    'M12 9l2.088 .008',
];

const ICONS: Record<string, string[]> = {
    [SNOWFLAKE_ICON_ID]: SNOWFLAKE,
    [SNOWFLAKE_OFF_ICON_ID]: SNOWFLAKE_OFF,
    [TEMP_SNOW_ICON_ID]: TEMPERATURE_SNOW,
};

const SNOWFLAKES = [SNOWFLAKE_ICON_ID, SNOWFLAKE_OFF_ICON_ID];

function icons(ids: string[]): MapIcon[] {
    return ids.filter((id) => ICONS[id]).map((id) => ({ id, paths: ICONS[id], style: 'light' }));
}

/** Add the given icons to the map style if missing; false if the browser cannot draw them. */
export function ensureSnowIcons(map: LiveWxMap, ids: string[] = SNOWFLAKES): boolean {
    return ensureMapIcons(map, icons(ids));
}

export function removeSnowIcons(map: LiveWxMap, ids: string[] = SNOWFLAKES): void {
    removeMapIcons(map, icons(ids));
}
