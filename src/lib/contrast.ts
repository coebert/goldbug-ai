// WCAG 2.1 contrast helpers used by chart-palette tests and any
// runtime accessibility guards. Kept pure so it runs in Vitest with
// no DOM.
//
// Supports the two colour syntaxes we actually use in this app:
//   - "#RRGGBB" hex literals (Okabe–Ito palette)
//   - "oklch(L C H)" values from src/styles.css theme tokens
//
// Not a full CSS parser: adding new syntaxes means adding a branch.

export type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`bad hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// OKLCh → OKLab → linear sRGB → gamma-encoded sRGB (Björn Ottosson).
function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  const enc = (u: number) => {
    const v = Math.max(0, Math.min(1, u));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return {
    r: Math.round(enc(lr) * 255),
    g: Math.round(enc(lg) * 255),
    b: Math.round(enc(lb) * 255),
  };
}

function parseOklch(input: string): Rgb {
  const m = input.trim().match(
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i,
  );
  if (!m) throw new Error(`unsupported oklch value: ${input}`);
  const rawL = m[1];
  const L = rawL.endsWith("%") ? Number(rawL.slice(0, -1)) / 100 : Number(rawL);
  return oklchToRgb(L, Number(m[2]), Number(m[3]));
}

// "hsl(H S% L%)" / "hsl(H, S%, L%)" — the syntax used by event-category hues.
function parseHsl(input: string): Rgb {
  const m = input
    .trim()
    .match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/].*)?\)$/i);
  if (!m) throw new Error(`unsupported hsl value: ${input}`);
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  };
}

export function parseColor(input: string): Rgb {
  const s = input.trim();
  if (s.startsWith("#")) return parseHex(s);
  if (s.toLowerCase().startsWith("oklch")) return parseOklch(s);
  if (s.toLowerCase().startsWith("hsl")) return parseHsl(s);
  throw new Error(`unsupported colour syntax: ${input}`);
}

// WCAG 2.1 relative luminance.
export function relativeLuminance({ r, g, b }: Rgb): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(parseColor(fg));
  const l2 = relativeLuminance(parseColor(bg));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG AA thresholds.
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
// Graphical objects (axis lines, chart shapes, focus rings) share the
// 3:1 non-text minimum (WCAG 1.4.11).
export const AA_NON_TEXT = 3;
