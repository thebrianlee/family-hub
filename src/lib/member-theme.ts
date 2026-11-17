// Member colors, without per-person Tailwind tokens.
//
// Each member has one color from MEMBER_PALETTE. The root layout injects one
// CSS rule per member (memberThemeCss) that sets --member, --member-deep,
// --member-soft and --member-tint on the class `m-<id>`; the static utilities
// in globals.css (.bg-member, .text-member-deep, ...) read those variables.
// A member's theme is then plain class strings such as "m-riley bg-member".
//
// Pure and dependency-free: used by the server layout and by client code.

export interface MemberTheme {
  /** Class strings, e.g. "m-riley bg-member". Never built from user input other than a validated id. */
  bg: string;       // solid fill
  bgSoft: string;   // soft tint fill
  bgTint: string;   // faintest tint (row backgrounds)
  text: string;     // colored text on cream
  textDeep: string; // headings on soft tint
  border: string;
  fill: string;     // hex for SVG (jars, sparklines)
  fillSoft: string;
}

/** Member ids: CSS-safe slugs. Also the shape the ICS settings keys use (ics_url_<id>). */
export const MEMBER_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface PaletteColor {
  hex: string;
  name: string;
  /** Hand-tuned shades; derived from hex when omitted. */
  deep?: string;
  soft?: string;
  tint?: string;
}

/**
 * The fixed palette members pick from. The first five are the sample family's
 * colors; the first three keep the exact shades their old Tailwind tokens had,
 * so the sample family looks the same as before.
 */
export const MEMBER_PALETTE: readonly PaletteColor[] = [
  { hex: "#6E9BBD", name: "Sky", deep: "#3E6D8F", soft: "#E2ECF4", tint: "#F0F5F9" },
  { hex: "#7FA576", name: "Sage", deep: "#4E7448", soft: "#E4EEE0", tint: "#F1F6EF" },
  { hex: "#D9A254", name: "Honey", deep: "#A0702B", soft: "#F6E8D0", tint: "#FAF2E4" },
  { hex: "#5E7B86", name: "Slate" },
  { hex: "#8A6D9E", name: "Plum" },
  { hex: "#C2738A", name: "Rose" },
  { hex: "#4E978F", name: "Teal" },
  { hex: "#6C79B8", name: "Indigo" },
  { hex: "#B5785A", name: "Clay" },
];

/** Default color for an unknown member and the parent look. */
export const NEUTRAL_COLOR = "#5E7B86";

export function isPaletteColor(hex: unknown): hex is string {
  return typeof hex === "string" && MEMBER_PALETTE.some((p) => p.hex === hex.toUpperCase());
}

/** Upper-case #RRGGBB, or null when it is not a hex color. */
export function normalizeHex(hex: unknown): string | null {
  return typeof hex === "string" && HEX_RE.test(hex) ? hex.toUpperCase() : null;
}

/** First palette color not in `used` (in `order`), cycling when all are taken. */
export function nextUnusedColor(used: readonly string[], order: readonly string[] = MEMBER_PALETTE.map((p) => p.hex)): string {
  const taken = new Set(used.map((u) => u.toUpperCase()));
  return order.find((hex) => !taken.has(hex)) ?? order[used.length % order.length];
}

/** Parents default to the calmer colors first (the sample parents' Slate and Plum). */
export const PARENT_COLOR_ORDER: readonly string[] = [
  "#5E7B86",
  "#8A6D9E",
  ...MEMBER_PALETTE.map((p) => p.hex).filter((h) => h !== "#5E7B86" && h !== "#8A6D9E"),
];

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function toHex(rgb: number[]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Mix with white: t = 0 keeps the color, t = 1 is white. */
export function mixWithWhite(hex: string, t: number): string {
  return toHex(toRgb(hex).map((v) => v + (255 - v) * t));
}

/** Darken by scaling HSL lightness (0.35 = 35% darker), keeping hue and saturation. */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  const L = l * (1 - amount);
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [rr, gg, bb] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([rr, gg, bb].map((v) => (v + m) * 255));
}

export interface MemberShades {
  base: string;
  deep: string;
  soft: string;
  tint: string;
}

/** deep / soft / tint for a member color: the palette's tuned values, else derived. */
export function memberShades(hex: string): MemberShades {
  const base = normalizeHex(hex) ?? NEUTRAL_COLOR;
  const p = MEMBER_PALETTE.find((c) => c.hex === base);
  return {
    base,
    deep: p?.deep ?? darken(base, 0.35),
    soft: p?.soft ?? mixWithWhite(base, 0.8),
    tint: p?.tint ?? mixWithWhite(base, 0.9),
  };
}

/** The parent look is unchanged: the `parent` Tailwind token, not a member color. */
export const PARENT_THEME: MemberTheme = {
  bg: "bg-parent",
  bgSoft: "bg-parent-soft",
  bgTint: "bg-cream-raised",
  text: "text-ink-soft",
  textDeep: "text-ink",
  border: "border-parent",
  fill: "#5E7B86",
  fillSoft: "#E4EBED",
};

export function memberClass(id: string): string {
  return `m-${id}`;
}

/** Theme class strings for a kid. Parents use PARENT_THEME. */
export function memberTheme(id: string, color: string): MemberTheme {
  if (!MEMBER_ID_RE.test(id)) return PARENT_THEME;
  const s = memberShades(color);
  const m = memberClass(id);
  return {
    bg: `${m} bg-member`,
    bgSoft: `${m} bg-member-soft`,
    bgTint: `${m} bg-member-tint`,
    text: `${m} text-member-deep`,
    textDeep: `${m} text-member-deep`,
    border: `${m} border-member`,
    fill: s.base,
    fillSoft: s.soft,
  };
}

/** CSS.escape for an identifier, for environments without it (the server). */
export function cssEscapeIdent(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    const safe = /[a-zA-Z0-9_-]/.test(ch) && !(i === 0 && /[0-9]/.test(ch)) && !(i === 1 && /[0-9]/.test(ch) && value[0] === "-");
    out += safe ? ch : `\\${code.toString(16)} `;
  }
  return out;
}

/**
 * One rule per member: `.m-<id>{--member:…;--member-deep:…;--member-soft:…;--member-tint:…}`.
 * Members whose id is not a valid slug or whose color is not #RRGGBB get no
 * rule. Ids are escaped anyway, and the output never contains "<".
 */
export function memberThemeCss(members: readonly { id: string; color: string }[]): string {
  const rules: string[] = [];
  for (const m of members) {
    if (typeof m.id !== "string" || !MEMBER_ID_RE.test(m.id)) continue;
    const hex = normalizeHex(m.color);
    if (!hex) continue;
    const s = memberShades(hex);
    rules.push(
      `.${cssEscapeIdent(memberClass(m.id))}{--member:${s.base};--member-deep:${s.deep};--member-soft:${s.soft};--member-tint:${s.tint}}`
    );
  }
  return rules.join("\n").replace(/</g, "\\3c ");
}

export function hexToRgba(hex: string, a: number): string {
  const [r, g, b] = toRgb(normalizeHex(hex) ?? NEUTRAL_COLOR);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
