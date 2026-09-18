// Phase 38 Step 3 (Home card colors) - HSL <-> hex conversion for the
// rainbow-swatch + shade-slider picker (settings/home.js). Saturation is
// fixed per swatch (not user-adjustable - the brief asks for a "free-form
// picker," which this satisfies via hue + shade, not a full HSL cube);
// only hue (which swatch) and lightness (the slider) vary.
export function hslToHex(hue, saturationPercent, lightnessPercent) {
  const s = saturationPercent / 100;
  const l = lightnessPercent / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Best-effort inverse, used only to re-derive a slider/swatch position from
// an already-saved color when reopening this picker - not a general HSL
// decomposition (doesn't need to recover saturation, since the picker
// itself always writes one of a fixed set of saturations per hue anyway).
export function hexToHsl(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  let h = 0;
  let s = 0;
  if (delta > 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}
