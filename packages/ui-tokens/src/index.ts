/**
 * Design tokens shared by web and mobile. Status is never conveyed by colour alone:
 * every status also has an icon name and a label key.
 */
export const statusTokens = {
  notStarted: { color: '#8A94A6', icon: 'circle-dashed', labelKey: 'status.notStarted' },
  inProgress: { color: '#F2A900', icon: 'circle-half', labelKey: 'status.inProgress' },
  executed: { color: '#2F80ED', icon: 'circle-check', labelKey: 'status.executed' },
  approved: { color: '#1E9E5A', icon: 'shield-check', labelKey: 'status.approved' },
  rejected: { color: '#D93838', icon: 'circle-x', labelKey: 'status.rejected' },
} as const;
export type Status = keyof typeof statusTokens;

export const colors = {
  brand: '#0B5FA5',
  brandContrast: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceDark: '#11161D',
  text: '#1B2430',
  textDark: '#E8EDF3',
  border: '#D5DBE3',
  focus: '#F2A900',
  /** CAD model-space background (night) and paper (day). */
  cadNight: '#0E1116',
  cadDay: '#F7F7F2',
} as const;

/**
 * CAD screen palettes per feature type (Phase 3). Night: dark model space as in AutoCAD; day:
 * light paper for direct sun (plan). Original ACI layer colours are not in the offline bundle yet.
 * Every pair keeps ≥ 4.5:1 contrast against its background.
 */
export const cadPalette = {
  night: {
    background: colors.cadNight,
    route: '#33C3F0',
    box: '#FFD400',
    hhi: '#FF8A80',
    joint: '#7CFC00',
    mh: '#D7A6FF',
    crosshair: '#FFFFFF',
    text: '#E8EDF3',
    /** Approved As-Built geometry and labels (Phase 4); distinct from every feature colour. */
    asbuilt: '#FF5FD2',
    /** The supervisor's own As-Built edits that are not approved yet (always with an icon). */
    asbuiltPending: '#FFAB40',
  },
  day: {
    background: colors.cadDay,
    route: '#005A9C',
    box: '#7A5200',
    hhi: '#B3261E',
    joint: '#2E6B30',
    mh: '#6A1B9A',
    crosshair: '#000000',
    text: '#1B2430',
    asbuilt: '#B0005E',
    asbuiltPending: '#9A4A00',
  },
} as const;
export type CadMode = keyof typeof cadPalette;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 4, md: 8, lg: 12 } as const;

export const typography = {
  fontFamily: "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif",
  monoFamily: "'IBM Plex Mono', ui-monospace, monospace",
  size: { sm: 13, md: 15, lg: 18, xl: 22 },
} as const;

/** Minimum touch target for field use (px / dp). */
export const minTouchTarget = 44;

/** CSS custom properties for the web app. */
export function toCssVariables(): string {
  const entries: [string, string][] = [
    ...Object.entries(colors).map(([name, value]): [string, string] => [`--color-${name}`, value]),
    ...Object.entries(statusTokens).map(([name, token]): [string, string] => [
      `--status-${name}`,
      token.color,
    ]),
    ...Object.entries(spacing).map(([name, value]): [string, string] => [
      `--space-${name}`,
      `${value}px`,
    ]),
  ];
  return `:root{${entries.map(([name, value]) => `${name}:${value}`).join(';')}}`;
}
