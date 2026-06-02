/**
 * theme.ts — shared visual tokens for the RPG UI kit.
 *
 * Every UI Container reads colours / fonts / spacing from one `UiTheme` so the
 * whole kit re-skins from a single object. `DEFAULT_THEME` is a neutral dark
 * fantasy palette; pass a partial override to any component constructor to
 * retheme. Colours are Phaser-style 0xRRGGBB numbers; text colours are CSS hex
 * strings (Phaser text styles want strings).
 */

export interface UiTheme {
  /** Panel fill + border. */
  panelFill: number;
  panelFillAlpha: number;
  panelBorder: number;
  panelBorderAlpha: number;
  /** Accent (selection highlight, bar fills, titles). */
  accent: number;
  accentText: string;
  /** Body + muted text. */
  text: string;
  textMuted: string;
  /** Bar fills. */
  hpFill: number;
  mpFill: number;
  barTrack: number;
  /** Damage-number colours. */
  damageText: string;
  critText: string;
  healText: string;
  /** Typography. */
  fontFamily: string;
  /** Corner radius for rounded panels. */
  radius: number;
  /** Inner padding for panels. */
  pad: number;
}

export const DEFAULT_THEME: UiTheme = {
  panelFill: 0x1a1a2e,
  panelFillAlpha: 0.9,
  panelBorder: 0xffd84a,
  panelBorderAlpha: 0.85,
  accent: 0xffd84a,
  accentText: "#ffd84a",
  text: "#fff5e6",
  textMuted: "#9aa0b5",
  hpFill: 0x4caf50,
  mpFill: 0x3d7bd6,
  barTrack: 0x101018,
  damageText: "#ffffff",
  critText: "#ffd84a",
  healText: "#7be07b",
  fontFamily: "Verdana, Arial, sans-serif",
  radius: 12,
  pad: 12,
};

/** Merge a partial override onto the default theme. */
export function makeTheme(override?: Partial<UiTheme>): UiTheme {
  return { ...DEFAULT_THEME, ...override };
}
