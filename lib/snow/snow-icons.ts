/**
 * Snowflake map icons for the Snow Chances layer, drawn into MapLibre images.
 *
 * Paths are Tabler Icons "snowflake" and "snowflake-off" (outline, v3.49,
 * https://tabler.io/icons — MIT License, © Paweł Kuna). Drawn white with a dark
 * outline so they read on any basemap and on the chance-colored circle.
 */
import type { LiveWxMap } from '../core/map-types.ts';

export const SNOWFLAKE_ICON_ID = 'livewx-snowflake';
export const SNOWFLAKE_OFF_ICON_ID = 'livewx-snowflake-off';

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

/** Rendered size in device pixels (registered at pixelRatio 2 → 20 px on screen). */
const SIZE = 40;
/** Small margin so the outline is not clipped. */
const PAD = 2;

function draw(paths: string[]): ImageData | null {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof Path2D === 'undefined') return null;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const scale = (SIZE - PAD * 2) / 24;
    ctx.translate(PAD, PAD);
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const shapes = paths.map((d) => new Path2D(d));
    // Dark outline first, then the white glyph on top.
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.lineWidth = 4.2;
    for (const p of shapes) ctx.stroke(p);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    for (const p of shapes) ctx.stroke(p);
    return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** Add both icons to the map style if missing; false if the browser cannot draw them. */
export function ensureSnowIcons(map: LiveWxMap): boolean {
    if (!map.addImage) return false;
    for (const [id, paths] of [[SNOWFLAKE_ICON_ID, SNOWFLAKE], [SNOWFLAKE_OFF_ICON_ID, SNOWFLAKE_OFF]] as const) {
        if (map.hasImage?.(id)) continue;
        const image = draw([...paths]);
        if (!image) return false;
        map.addImage(id, image, { pixelRatio: 2 });
    }
    return true;
}

export function removeSnowIcons(map: LiveWxMap): void {
    for (const id of [SNOWFLAKE_ICON_ID, SNOWFLAKE_OFF_ICON_ID]) {
        try { if (map.hasImage?.(id)) map.removeImage?.(id); } catch { /* ignore */ }
    }
}
