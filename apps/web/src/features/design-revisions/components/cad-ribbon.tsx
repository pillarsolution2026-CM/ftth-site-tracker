'use client';

import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ltr, type MessageKey } from '@ftth/i18n';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { LayerRow } from '../hooks/use-drawing-viewer';
import type { LayerScreen } from '../hooks/use-layer-screen';
import { formatPrompt, type CanvasEditState } from '../hooks/use-canvas-edit';
import { ModifyText, TableTile, TextTool } from './text-panel';
import { HatchCreationTab } from './hatch-tab';
import {
  COMMANDS,
  PROMPTS_WITHOUT_OR,
  suggestCommands,
  type CommandId,
} from '../model/cad-commands';
import { ColorPicker, LinetypePicker, LineweightPicker } from './property-pickers';

/**
 * The AutoCAD-like workspace of the drawing (ADR-051): a dark ribbon laid out as AutoCAD's Home tab
 * (Draw | Modify | Annotation | Layers | Properties) and the command line under the canvas. The pen
 * on the canvas opens it; nothing is kept until «حفظ». The icons are this program's own.
 */

const DARK = {
  bar: 'bg-[#2b2f36] text-[#e8eaed] border-[#1b1e23]',
  tile: 'text-[#e8eaed] hover:bg-white/10',
  on: 'bg-[#3d6fb6] text-white',
  field: 'bg-[#1d2127] text-[#e8eaed] border border-[#4a505a]',
};

/** The view buttons that sit on the tab strip (owner 2026-11-26: moved from the canvas corner). */
export interface StripView {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** The in-page full-window mode: Esc never leaves it, only its button. */
  full: boolean;
  onToggleFull: () => void;
  layersOpen: boolean;
  onToggleLayers: () => void;
  /** The palettes beside the drawing (errors, corrections). */
  palettes: readonly { key: string; title: string; open: boolean; onToggle: () => void }[];
  /** AutoCAD's CURSORSIZE: small (5, with the pick box) or across the drawing (100). */
  crosshair: 'small' | 'full';
  onToggleCrosshair: () => void;
}

function Svg({ children, size = 'size-5' }: { children: ReactNode; size?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** This program's own drawings of the commands (in the spirit of a CAD ribbon). */
type IconKey =
  | CommandId
  | 'undo'
  | 'redo'
  | 'markers'
  | 'osm'
  | 'bedit'
  | 'attdef'
  | 'fade'
  | 'layerstate'
  | 'pen'
  | 'fit'
  | 'fullOn'
  | 'fullOff'
  | 'crossFull'
  | 'crossSmall'
  | 'save'
  | 'cancel'
  | 'paletteLayers'
  | 'paletteProblems'
  | 'paletteCorrections'
  | 'paletteProperties'
  | 'qselect'
  | 'selectall';
const ICONS: Partial<Record<IconKey, ReactNode>> = {
  line: (
    <>
      <path d="M4 19 19 5" />
      <rect x="2.5" y="17.5" width="3" height="3" />
      <rect x="17.5" y="3.5" width="3" height="3" />
    </>
  ),
  pline: (
    <>
      <path d="M3 18 8 8l5 7 8-10" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="15" r="1.2" />
    </>
  ),
  circle: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12h8" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  arc: (
    <>
      <path d="M4 18A9 9 0 0 1 20 18" />
      <rect x="2.5" y="16.5" width="3" height="3" />
      <rect x="18.5" y="16.5" width="3" height="3" />
      <rect x="10.5" y="7.2" width="3" height="3" />
    </>
  ),
  rectang: (
    <>
      <rect x="4" y="6" width="16" height="12" />
      <rect x="2.5" y="16.5" width="3" height="3" />
      <rect x="18.5" y="4.5" width="3" height="3" />
    </>
  ),
  point: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
    </>
  ),
  move: (
    <path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" />
      <path d="M15 9V4H4v11h5" />
    </>
  ),
  stretch: (
    <>
      <path d="M3 17h7l4-8h7" />
      <rect x="11" y="6" width="10" height="7" strokeDasharray="2 2" />
      <path d="M15 17h5M18 15l2 2-2 2" />
    </>
  ),
  rotate: (
    <>
      <path d="M19 12a7 7 0 1 1-2-4.9" />
      <path d="M19 4v4h-4" />
    </>
  ),
  mirror: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 7 4 17h5zM15 7l5 10h-5z" />
    </>
  ),
  scale: (
    <>
      <rect x="3" y="12" width="9" height="9" />
      <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" />
      <path d="M12 12l6-6M14 6h4v4" />
    </>
  ),
  trim: (
    <>
      <path d="M12 3v18" />
      <path d="M3 12h9" />
      <path d="M12 12h9" strokeDasharray="2 2" />
      <path d="M16 9l4 6M20 9l-4 6" />
    </>
  ),
  fillet: (
    <>
      <path d="M4 20V12a8 8 0 0 1 8-8h8" />
      <path d="M4 4h4M4 4v4" strokeDasharray="1.5 1.5" />
    </>
  ),
  erase: (
    <>
      <path d="M8 20h12" />
      <path d="M4 15 13 6l6 6-7 7H8z" />
      <path d="M8.5 10.5l6 6" />
    </>
  ),
  offset: (
    <>
      <path d="M3 9c4-4 8 4 12 0s4-3 6-3" />
      <path d="M3 16c4-4 8 4 12 0s4-3 6-3" strokeDasharray="2 2" />
    </>
  ),
  join: (
    <>
      <path d="M3 16 10 9" />
      <path d="M14 9l7 7" />
      <path d="M10 9h4" strokeDasharray="1.5 1.5" />
    </>
  ),
  text: <path d="M5 5h14M12 5v14M9 19h6" />,
  textedit: (
    <>
      <path d="M4 5h10M9 5v10" />
      <path d="M13 20l1-3 6-6 2 2-6 6z" />
    </>
  ),
  dimlinear: (
    <>
      <path d="M4 6v12M20 6v12M4 12h16" />
      <path d="M4 12l3-2v4zM20 12l-3-2v4z" />
    </>
  ),
  leader: (
    <>
      <path d="M4 20 12 10h8" />
      <path d="M4 20l1-4 3 2z" />
    </>
  ),
  layer: (
    <>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M17 17h5M19.5 14.5v5" />
    </>
  ),
  matchprop: (
    <>
      <path d="M14 4l6 6-8 8-6-6z" />
      <path d="M6 12l-3 8 8-3" />
    </>
  ),
  laymcur: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M8 17l3 3 6-6" />
    </>
  ),
  laymch: (
    <>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="M5 17h14M15 14l4 3-4 3" />
    </>
  ),
  spline: (
    <>
      <path d="M3 17c3-9 6-9 9-3s6 6 9-5" />
      <circle cx="3" cy="17" r="1.2" />
      <circle cx="12" cy="14" r="1.2" />
      <circle cx="21" cy="9" r="1.2" />
    </>
  ),
  ellipse: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="5.5" />
      <path d="M3 12h18" strokeDasharray="1.5 1.5" />
    </>
  ),
  polygon: <path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z" />,
  xline: (
    <>
      <path d="M2 20 22 4" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  ray: (
    <>
      <path d="M5 19 22 5" />
      <circle cx="5" cy="19" r="1.6" />
    </>
  ),
  divide: (
    <>
      <path d="M3 16c4-8 14-8 18 0" />
      <path d="M7.5 10.5v2M12 8.5v2M16.5 10.5v2" />
    </>
  ),
  measure: (
    <>
      <path d="M3 17h18" />
      <path d="M5 14v3M9 15v2M13 14v3M17 15v2M21 14v3" />
    </>
  ),
  region: <path d="M4 18 6 6l8-2 6 7-4 8z" fill="currentColor" fillOpacity="0.25" />,
  hatch: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M4 10l6-6M4 16 16 4M8 20 20 8M14 20l6-6" />
    </>
  ),
  gradient: (
    <>
      <defs>
        <linearGradient id="cad-gradient-icon" x1="0" x2="1">
          <stop offset="0" stopColor="#7fb2ff" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="16" height="16" fill="url(#cad-gradient-icon)" />
    </>
  ),
  boundary: (
    <>
      <path d="M4 18 6 6l8-2 6 7-4 8z" strokeDasharray="2 1.5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  wipeout: (
    <>
      <path d="M3 8h18M3 13h18M3 18h18" opacity="0.5" />
      <rect x="7" y="6" width="10" height="10" fill="#000" />
    </>
  ),
  helix: <path d="M11 12a1 1 0 1 1 2 0a3 3 0 1 1-6 0a5 5 0 1 1 10 0a7 7 0 1 1-14 0" />,
  donut: (
    <>
      <circle cx="12" cy="12" r="8" fill="currentColor" fillOpacity="0.85" />
      <circle cx="12" cy="12" r="3.5" fill="#2b2f36" />
    </>
  ),
  break: (
    <>
      <path d="M3 12h6M15 12h6" />
      <path d="M9 9v6M15 9v6" strokeDasharray="1.5 1.5" />
    </>
  ),
  breakatpoint: (
    <>
      <path d="M3 12h7M14 12h7" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  lengthen: (
    <>
      <path d="M3 12h12" />
      <path d="M15 12h6" strokeDasharray="2 1.5" />
      <path d="M18 9l3 3-3 3" />
    </>
  ),
  reverse: <path d="M4 9h14l-3-3M20 15H6l3 3" />,
  arraypolar: (
    <>
      <circle cx="12" cy="12" r="7" strokeDasharray="2 2" />
      <rect x="10" y="3" width="4" height="4" />
      <rect x="17" y="10" width="4" height="4" />
      <rect x="10" y="17" width="4" height="4" />
      <rect x="3" y="10" width="4" height="4" />
    </>
  ),
  arraypath: (
    <>
      <path d="M3 19C8 19 8 5 21 5" strokeDasharray="2 2" />
      <rect x="2" y="16" width="4" height="4" />
      <rect x="9" y="9" width="4" height="4" />
      <rect x="17" y="3" width="4" height="4" />
    </>
  ),
  chamfer: (
    <>
      <path d="M4 20V10l6-6h10" />
      <path d="M4 4h4M4 4v4" strokeDasharray="1.5 1.5" />
    </>
  ),
  arrayrect: (
    <>
      <rect x="3" y="3" width="5" height="5" />
      <rect x="10" y="3" width="5" height="5" />
      <rect x="17" y="3" width="4" height="5" />
      <rect x="3" y="11" width="5" height="5" />
      <rect x="10" y="11" width="5" height="5" />
      <rect x="17" y="11" width="4" height="5" />
    </>
  ),
  overkill: (
    <>
      <path d="M14 3l7 7-8 8-4-4z" />
      <path d="M9 14l-5 7M6 12l-3 3" />
    </>
  ),
  draworder: (
    <>
      <rect x="3" y="3" width="11" height="11" />
      <rect x="10" y="10" width="11" height="11" fill="currentColor" fillOpacity="0.35" />
    </>
  ),
  layoff: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M15 16l5 5M20 16l-5 5" />
    </>
  ),
  layiso: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <rect x="14" y="15" width="6" height="6" />
    </>
  ),
  layuniso: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <rect x="14" y="15" width="6" height="6" strokeDasharray="1.5 1.5" />
    </>
  ),
  layfrz: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M18 14v8M14.5 16l7 4M14.5 20l7-4" />
    </>
  ),
  laythw: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M18 13.5v1.5M18 21v1.5M13.5 18H15M21 18h1.5" />
    </>
  ),
  laylck: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <rect x="14" y="17" width="7" height="5" />
      <path d="M15.5 17v-2a2 2 0 0 1 4 0v2" />
    </>
  ),
  layulk: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <rect x="14" y="17" width="7" height="5" />
      <path d="M15.5 17v-2a2 2 0 0 1 3.8-.8" />
    </>
  ),
  layon: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M16 18h5M18.5 15.5v5" />
    </>
  ),
  layerp: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M20 20h-6l2-2M14 20l2 2" />
    </>
  ),
  laycur: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M14 18h7M18 15l3 3-3 3" />
    </>
  ),
  copytolayer: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <rect x="13" y="15" width="5" height="5" />
      <rect x="16" y="17" width="5" height="5" />
    </>
  ),
  laywalk: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M15 21l2-5 2 5M16 19h2" />
    </>
  ),
  laymrg: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M14 15l3 3 3-3M17 18v4" />
    </>
  ),
  laydel: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M14 16h7M15 16l.7 6h3.6l.7-6" />
    </>
  ),
  find: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M14.5 14.5 21 21" />
    </>
  ),
  group: (
    <>
      <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" />
      <rect x="6" y="6" width="5" height="5" />
      <circle cx="15.5" cy="15.5" r="2.5" />
    </>
  ),
  ungroup: (
    <>
      <rect x="3" y="3" width="8" height="8" />
      <circle cx="17" cy="17" r="3" />
      <path d="M14 3h7v7" strokeDasharray="1.5 1.5" />
    </>
  ),
  groupedit: (
    <>
      <rect x="3" y="3" width="14" height="14" strokeDasharray="2 2" />
      <path d="M13 21l1-3 6-6 2 2-6 6z" />
    </>
  ),
  pickstyle: (
    <>
      <rect x="3" y="3" width="13" height="13" strokeDasharray="2 2" />
      <path d="M14 14l7 3-3 1-1 3z" />
    </>
  ),
  block: (
    <>
      <path d="M4 8l8-4 8 4-8 4z" />
      <path d="M4 8v8l8 4 8-4V8M12 12v8" />
      <path d="M19 2v4M17 4h4" />
    </>
  ),
  insert: (
    <>
      <path d="M4 8l8-4 8 4-8 4z" />
      <path d="M4 8v8l8 4 8-4V8M12 12v8" />
    </>
  ),
  eattedit: (
    <>
      <path d="M4 8l8-4 8 4-8 4z" />
      <path d="M13 21l1-3 6-6 2 2-6 6z" />
    </>
  ),
  bedit: (
    <>
      <path d="M4 8l8-4 8 4-8 4z" />
      <path d="M4 8v8l8 4M14 21l1-3 5-5 2 2-5 5z" />
    </>
  ),
  attdef: (
    <>
      <rect x="3" y="6" width="18" height="12" />
      <path d="M7 15l2-6 2 6M7.7 13h2.6M14 9h4M14 12h4M14 15h3" />
    </>
  ),
  fade: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" opacity="0.45" />
      <path d="M3 14l9 5 9-5" />
    </>
  ),
  layerstate: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M3 14l9 5 9-5" />
      <path d="M3 19l9 5" opacity="0" />
    </>
  ),
  undo: <path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="M15 4l5 5-5 5M20 9H10a6 6 0 0 0 0 12h3" />,
  // The error markers (item 32): a map pin over a target ring, not a warning triangle.
  markers: (
    <>
      <path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.2" />
      <path d="M7.5 21h9" opacity="0.6" />
    </>
  ),
  osm: (
    <>
      <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
      <path d="M14 6l3 3" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 12h6M12 9v6" />,
  fullOn: <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />,
  fullOff: <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />,
  crossFull: <path d="M12 2v20M2 12h20M10 10h4v4h-4z" />,
  crossSmall: <path d="M12 7v10M7 12h10M10 10h4v4h-4z" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
  cancel: <path d="M6 6l12 12M18 6 6 18" />,
  paletteLayers: <path d="M12 3 3 8l9 5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />,
  paletteProblems: (
    <>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  paletteCorrections: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  paletteProperties: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  // Round 3: Utilities, Clipboard and the added Modify tools.
  measuregeom: (
    <>
      <path d="M3 17 17 3l4 4L7 21z" />
      <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
    </>
  ),
  id: (
    <>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  list: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  extend: (
    <>
      <path d="M20 3v18" />
      <path d="M3 12h9" />
      <path d="M12 12h8" strokeDasharray="2 2" />
      <path d="M15 9l3 3-3 3" />
    </>
  ),
  explode: (
    <>
      <path d="M4 14l5-5M11 5l4 4M19 11l-4 6" />
      <path d="M3 4l2 2M21 4l-2 2M3 20l2-2M21 20l-2-2" strokeDasharray="1.5 1.5" />
    </>
  ),
  pasteclip: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="1" />
      <rect x="9" y="2.5" width="6" height="3" rx="0.5" />
      <path d="M9 11h6M9 15h6" />
    </>
  ),
  cutclip: (
    <>
      <circle cx="7" cy="18" r="3" />
      <circle cx="17" cy="18" r="3" />
      <path d="M9 16 18 3M15 16 6 3" />
    </>
  ),
  copyclip: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="1" />
      <path d="M16 8V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3" />
    </>
  ),
  copybase: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="1" />
      <path d="M16 8V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3" />
      <circle cx="8" cy="21" r="1.5" />
    </>
  ),
  qselect: (
    <>
      <path d="M4 5h16l-6 7v6l-4 2v-8z" />
    </>
  ),
  selectall: (
    <>
      <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
};

/** Palette key → its icon on the tab strip (icons only, owner 2026-11-26). */
const PALETTE_ICON: Record<string, IconKey> = {
  problems: 'paletteProblems',
  corrections: 'paletteCorrections',
  properties: 'paletteProperties',
};
/** The tab strip names its tools in English in every language (owner 2026-11-26). */
const PALETTE_NAME: Record<string, 'errors' | 'corrections' | 'properties'> = {
  problems: 'errors',
  corrections: 'corrections',
  properties: 'properties',
};

/** A small button on the dark tab strip next to «Home» (Undo, Redo, the view buttons). */
function StripButton({
  label,
  onClick,
  disabled,
  pressed,
  title,
  className = '',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** The tooltip when it says more than the name. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`relative mb-0.5 flex min-h-7 min-w-8 items-center justify-center gap-1 rounded px-1 focus-visible:outline-2 focus-visible:outline-(--color-focus) disabled:opacity-35 ${
        pressed ? DARK.on : DARK.tile
      } ${className}`}
    >
      {children}
    </button>
  );
}

const StripSeparator = () => (
  <span aria-hidden="true" className="mx-1 mb-1 h-4 border-s border-[#454b55]" />
);

/**
 * The tab strip (owner 2026-11-26): always shown, also before editing. «Home», the pen that opens
 * the workspace (in it «حفظ» and «إلغاء»), Undo / Redo, the error markers, the view buttons moved
 * from the canvas corner, the palettes and the crosshair size.
 */
function TabStrip({
  edit,
  markersShown,
  onToggleMarkers,
  view,
}: {
  edit: CanvasEditState;
  markersShown: boolean;
  onToggleMarkers: () => void;
  view: StripView;
}) {
  const { t } = useI18n();
  // English on the tab strip in every language (owner 2026-11-26).
  const markersLabel = markersShown
    ? t('design.cad.strip.markersHide')
    : t('design.cad.strip.markersShow');
  const count = edit.edits.length;
  const editing = edit.available && edit.editing;
  const crossLabel =
    view.crosshair === 'full' ? t('design.cad.crosshairSmall') : t('design.cad.crosshairFull');
  return (
    <div
      role="group"
      aria-label={t('design.cad.quickAccess')}
      className="flex flex-wrap items-end gap-1 bg-[#1f2328] px-2 pt-1 text-xs"
    >
      <span
        className={`rounded-t px-3 py-1 font-semibold ${edit.hatch ? 'text-[#aab0b8]' : 'bg-[#2b2f36]'}`}
      >
        {t('design.cad.home')}
      </span>
      {edit.hatch ? (
        <span className="rounded-t bg-[#2b2f36] px-3 py-1 font-semibold text-[#9fd17a]">
          {t('design.cad.hatch.tab')}
        </span>
      ) : null}
      <StripSeparator />
      {edit.available && !edit.editing ? (
        <StripButton label={t('design.edit.start')} onClick={edit.start}>
          <Svg size="size-4">{ICONS.pen}</Svg>
        </StripButton>
      ) : null}
      {editing && edit.hatch === null ? (
        <>
          <StripButton
            label={`${t('design.cad.strip.save')}${count > 0 ? ` (${count})` : ''}`}
            title={`${t('design.cad.strip.save')} (Ctrl+S) — ${t('design.edit.saveHint')}`}
            onClick={edit.save}
            disabled={edit.saving}
            className="bg-[#3d6fb6] px-2 font-semibold text-white hover:bg-[#4a7fca]"
          >
            <Svg size="size-4">{ICONS.save}</Svg>
            {count > 0 ? (
              <span aria-hidden="true" dir="ltr">
                {count}
              </span>
            ) : null}
          </StripButton>
          <StripButton
            label={t('design.cad.strip.cancel')}
            title={`${t('design.cad.strip.cancel')} — ${t('design.edit.cancelHint')}`}
            onClick={edit.cancel}
            disabled={edit.saving}
          >
            <Svg size="size-4">{ICONS.cancel}</Svg>
          </StripButton>
        </>
      ) : null}
      <StripButton
        label={`${t('design.cad.undo')} (Ctrl+Z)`}
        onClick={edit.undo}
        disabled={!editing || !edit.canUndo}
      >
        <Svg size="size-4">{ICONS.undo}</Svg>
      </StripButton>
      <StripButton
        label={`${t('design.cad.redo')} (Ctrl+Y)`}
        onClick={edit.redo}
        disabled={!editing || !edit.canRedo}
      >
        <Svg size="size-4">{ICONS.redo}</Svg>
      </StripButton>
      <StripButton label={markersLabel} pressed={!markersShown} onClick={onToggleMarkers}>
        <Svg size="size-4">{ICONS.markers}</Svg>
        {markersShown ? null : (
          <span
            aria-hidden="true"
            data-testid="markers-slash"
            className="absolute inset-x-1.5 top-1/2 h-0.5 -rotate-45 bg-[#ff6b6b]"
          />
        )}
      </StripButton>
      <StripSeparator />
      <StripButton label={t('design.viewer.zoomIn')} onClick={view.zoomIn}>
        <span className="text-base leading-none">+</span>
      </StripButton>
      <StripButton label={t('design.viewer.zoomOut')} onClick={view.zoomOut}>
        <span className="text-base leading-none">−</span>
      </StripButton>
      <StripButton label={t('design.viewer.fit')} onClick={view.fit}>
        <Svg size="size-4">{ICONS.fit}</Svg>
      </StripButton>
      <StripButton
        label={view.full ? t('design.cad.fullScreenExit') : t('design.cad.fullScreen')}
        title={`${view.full ? t('design.cad.fullScreenExit') : t('design.cad.fullScreen')} — ${t('design.cad.fullScreenHint')}`}
        pressed={view.full}
        onClick={view.onToggleFull}
      >
        <Svg size="size-4">{view.full ? ICONS.fullOff : ICONS.fullOn}</Svg>
      </StripButton>
      <StripButton
        label={crossLabel}
        pressed={view.crosshair === 'small'}
        onClick={view.onToggleCrosshair}
      >
        <Svg size="size-4">{view.crosshair === 'full' ? ICONS.crossFull : ICONS.crossSmall}</Svg>
      </StripButton>
      <StripSeparator />
      <StripButton
        label={t('design.cad.strip.layers')}
        title={t('design.cad.paletteToggle', { name: t('design.cad.strip.layers') })}
        pressed={view.layersOpen}
        onClick={view.onToggleLayers}
      >
        <Svg size="size-4">{ICONS.paletteLayers}</Svg>
      </StripButton>
      {view.palettes.map((p) => {
        const name = t(`design.cad.strip.${PALETTE_NAME[p.key] ?? 'properties'}` as MessageKey);
        return (
          <StripButton
            key={p.key}
            label={name}
            title={t('design.cad.paletteToggle', { name })}
            pressed={p.open}
            onClick={p.onToggle}
          >
            <Svg size="size-4">{ICONS[PALETTE_ICON[p.key] ?? 'paletteProperties']}</Svg>
          </StripButton>
        );
      })}
    </div>
  );
}

function shortcutOf(id: CommandId): string {
  const def = COMMANDS[id];
  return def.aliases[0] ?? def.name;
}

/** A small icon-only tool, as AutoCAD's compact panel rows (the name shows on hover). */
function LayerStates({ screen }: { screen: LayerScreen }) {
  const { t } = useI18n();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const unsaved = t('design.cad.layerStateUnsaved');
  return (
    <div className="flex items-center gap-0.5">
      <select
        aria-label={t('design.cad.layerStates')}
        title={t('design.cad.layerStates')}
        className={`min-h-7 w-44 rounded px-1 text-xs ${DARK.field}`}
        value={screen.current ?? ''}
        onChange={(event) => {
          if (event.target.value) screen.restoreState(event.target.value);
        }}
      >
        <option value="">{unsaved}</option>
        {screen.states.map((state) => (
          <option key={state} value={state}>
            {state}
          </option>
        ))}
      </select>
      {naming ? (
        <form
          className="flex items-center gap-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            screen.saveState(name);
            setName('');
            setNaming(false);
          }}
        >
          <input
            aria-label={t('design.cad.layerStateName')}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            className={`min-h-7 w-28 rounded px-1 text-xs ${DARK.field}`}
          />
          <button type="submit" className={`min-h-7 rounded px-1.5 text-xs ${DARK.tile}`}>
            {t('design.cad.layerStateSave')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          aria-label={t('design.cad.layerStateNew')}
          title={t('design.cad.layerStateNew')}
          onClick={() => setNaming(true)}
          className={`min-h-7 min-w-7 rounded text-xs ${DARK.tile}`}
        >
          +
        </button>
      )}
      {screen.current ? (
        <button
          type="button"
          aria-label={t('design.cad.layerStateDelete', { name: screen.current })}
          title={t('design.cad.layerStateDelete', { name: screen.current })}
          onClick={() => screen.current && screen.deleteState(screen.current)}
          className={`min-h-7 min-w-7 rounded text-xs ${DARK.tile}`}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** Locked layer fading: on / off and how much (AutoCAD's slider, 0-90 %). */
function LockedFading({ screen }: { screen: LayerScreen }) {
  const { t } = useI18n();
  const { fade } = screen;
  return (
    <div className="flex items-center gap-1 text-xs">
      <button
        type="button"
        aria-pressed={fade.on}
        aria-label={t('design.cad.lockedFading')}
        title={t('design.cad.lockedFading')}
        onClick={() => screen.setFade({ ...fade, on: !fade.on })}
        className={`flex min-h-7 min-w-7 items-center justify-center rounded ${fade.on ? DARK.on : DARK.tile}`}
      >
        <Svg size="size-4">{ICONS.fade}</Svg>
      </button>
      <input
        type="range"
        min={0}
        max={90}
        step={5}
        value={fade.percent}
        aria-label={t('design.cad.lockedFadingPercent')}
        onChange={(event) => screen.setFade({ ...fade, percent: Number(event.target.value) })}
        className="w-24"
      />
      <span dir="ltr" className="w-9 text-end">
        {fade.percent}%
      </span>
    </div>
  );
}

function Tile({ edit, id }: { edit: CanvasEditState; id: CommandId }) {
  const { t } = useI18n();
  const on = edit.command === id;
  const label = t(`design.cad.tool.${id}` as MessageKey);
  const hint = `${t(`design.cad.hint.${id}` as MessageKey)} — ${COMMANDS[id].name} (${shortcutOf(id)})`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={hint}
      onClick={() => edit.run(id)}
      className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
        on ? DARK.on : DARK.tile
      }`}
    >
      <Svg size="size-4">{ICONS[id]}</Svg>
      <span dir="ltr" className="whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

/** A tool that runs a command with an option already chosen (Spline CV, Multiple Points). */
function Variant({
  edit,
  id,
  option,
  label,
}: {
  edit: CanvasEditState;
  id: CommandId;
  option: string;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — ${COMMANDS[id].name}`}
      onClick={() => edit.runWith(id, option)}
      className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-(--color-focus) ${DARK.tile}`}
    >
      <Svg size="size-4">{ICONS[id]}</Svg>
      <span dir="ltr" className="whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

/** A panel's side padding and border (px-2 + border-e), px. */
const PANEL_PAD_PX = 17;
/** The gap between two tools of a panel (gap-0.5), px. */
const TOOL_GAP_PX = 2;

/**
 * Each panel's width (owner 2026-11-26, items 31 + 31b): the ribbon's width divided EQUALLY between
 * all panels, filling the bar; 0 while the ribbon is not laid out (every panel takes what it needs).
 */
export function panelShare(rowWidth: number, panels: number): number {
  return rowWidth > 0 && panels > 0 ? Math.floor(rowWidth / panels) : 0;
}

/**
 * How many of a panel's tools (left to right) fit in its share; the others go under the ▾ next to
 * its title. One tool always stays, so no panel collapses to a bare title (item 31b). A share of 0
 * (not laid out) shows every tool.
 */
export function fittingTools(widths: readonly number[], share: number): number {
  if (share <= 0) return widths.length;
  const room = share - PANEL_PAD_PX;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    used += (count > 0 ? TOOL_GAP_PX : 0) + width;
    if (used > room) break;
    count++;
  }
  return Math.max(Math.min(1, widths.length), count);
}

/** The panels left to right (every one gets the same share of the ribbon). */
export const PANEL_ORDER = [
  'draw',
  'modify',
  'annotation',
  'text',
  'layers',
  'groups',
  'block',
  'properties',
  'utilities',
  'clipboard',
] as const satisfies readonly string[];

/** Panels that take more than one share: Layers has the old Map panel's room too (owner). */
export const PANEL_WEIGHT: Readonly<Record<string, number>> = { layers: 2 };

/** All the shares of the ribbon (one per panel, more for the wide ones). */
export const PANEL_SHARES = PANEL_ORDER.reduce((sum, id) => sum + (PANEL_WEIGHT[id] ?? 1), 0);

/** The width each panel gets (px), 0 until the ribbon is measured. */
export const RibbonFit = createContext<{ share: number }>({ share: 0 });

/** The tools of a panel one by one: a `Rows` block gives one tool per column of three. */
function toolsOf(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  Children.toArray(children).forEach((child, i) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Rows) {
      const small = Children.toArray(child.props.children);
      for (let at = 0; at < small.length; at += 3) {
        out.push(
          <div key={`rows-${i}-${at}`} className="grid grid-rows-3 gap-y-0">
            {small.slice(at, at + 3)}
          </div>,
        );
      }
    } else out.push(child);
  });
  return out;
}

/**
 * One panel of AutoCAD's ribbon at its equal share of the width: the tools that fit, then the
 * title; the ▾ next to the title opens what did not fit and the panel's slide-out tools.
 */
export function Panel({
  id,
  title,
  more,
  children,
}: {
  /** Key of the panel in the ribbon's order. */
  id: string;
  title: string;
  /** AutoCAD's slide-out: more tools under the panel, opened by the arrow next to its title. */
  more?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { share: one } = useContext(RibbonFit);
  const share = one * (PANEL_WEIGHT[id] ?? 1);
  const [open, setOpen] = useState(false);
  const tools = toolsOf(children);
  const widths = useRef<number[]>([]);
  const toolRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [shown, setShown] = useState(tools.length);
  // Measure the tools on the row (those under ▾ keep their last width) and refit.
  useLayoutEffect(() => {
    toolRefs.current.forEach((element, i) => {
      if (element && element.offsetWidth > 0) widths.current[i] = element.offsetWidth;
    });
    const all = tools.map((_, i) => widths.current[i] ?? 0);
    const next = fittingTools(all, share);
    if (next !== shown) setShown(next);
  });
  const fits = Math.min(shown, tools.length);
  const overflow = tools.slice(fits);
  const hasMore = overflow.length > 0 || more !== undefined;
  const moreLabel = t('design.cad.panelMore', { panel: title });
  return (
    <div
      role="group"
      aria-label={title}
      data-panel={id}
      style={share > 0 ? { width: share } : undefined}
      className="relative flex shrink-0 flex-col border-e border-[#454b55] px-2 last:border-e-0"
    >
      <div className="flex flex-1 flex-nowrap items-start gap-0.5 overflow-hidden">
        {tools.slice(0, fits).map((tool, i) => (
          <div
            key={i}
            ref={(element) => {
              toolRefs.current[i] = element;
            }}
            className="flex shrink-0"
          >
            {tool}
          </div>
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={moreLabel}
          title={moreLabel}
          onClick={() => setOpen(!open)}
          dir="ltr"
          className={`mt-1 truncate rounded-sm text-center text-[11px] hover:bg-white/10 ${
            open ? 'bg-[#3d6fb6] text-white' : 'bg-[#22262c] text-[#aab0b8]'
          }`}
        >
          {title} <span aria-hidden="true">▾</span>
        </button>
      ) : (
        <div
          dir="ltr"
          className="mt-1 truncate rounded-sm bg-[#22262c] text-center text-[11px] text-[#aab0b8]"
        >
          {title}
        </div>
      )}
      {hasMore && open ? (
        <div
          role="group"
          aria-label={moreLabel}
          className="absolute start-0 top-full z-30 mt-0.5 flex w-max min-w-full max-w-[32rem] flex-col gap-1 rounded-b border border-[#454b55] bg-[#2b2f36] p-1.5 shadow-lg"
        >
          {overflow.length > 0 ? (
            <div className="flex flex-wrap items-start gap-0.5">
              {overflow.map((tool, i) => (
                <div key={fits + i} className="flex">
                  {tool}
                </div>
              ))}
            </div>
          ) : null}
          {more ? <div className="flex flex-wrap gap-0.5">{more}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tool with a drop-down of its variants (AutoCAD's split buttons: Hatch, Ellipse, Draw Order).
 * Each item runs a command, with an option already chosen when it names one.
 */
function SplitTool({
  edit,
  label,
  icon,
  items,
}: {
  edit: CanvasEditState;
  label: string;
  icon: CommandId;
  items: { label: string; icon: CommandId; id: CommandId; option?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [first] = items;
  const go = (item: { id: CommandId; option?: string }) => {
    setOpen(false);
    if (item.option) edit.runWith(item.id, item.option);
    else edit.run(item.id);
  };
  return (
    <div className="relative flex">
      <button
        type="button"
        aria-label={label}
        aria-pressed={items.some((item) => edit.command === item.id)}
        title={label}
        onClick={() => {
          if (first) go(first);
        }}
        className={`flex min-h-8 items-center gap-1.5 rounded-s px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-(--color-focus) ${DARK.tile}`}
      >
        <Svg size="size-4">{ICONS[icon]}</Svg>
        <span dir="ltr" className="whitespace-nowrap">
          {label}
        </span>
      </button>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} ▾`}
        onClick={() => setOpen(!open)}
        className={`min-h-8 rounded-e px-1 text-xs ${DARK.tile}`}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          role="menu"
          aria-label={label}
          className={`absolute start-0 top-full z-40 mt-0.5 min-w-44 rounded border border-[#4a505a] py-1 shadow-lg ${DARK.bar}`}
        >
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => go(item)}
                className="flex min-h-8 w-full items-center gap-2 px-2 text-start text-xs hover:bg-white/10"
              >
                <Svg size="size-4">{ICONS[item.icon]}</Svg>
                <span dir="ltr">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Small tools in AutoCAD's three rows. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="grid grid-flow-col grid-rows-3 gap-x-1">{children}</div>;
}

export function CadRibbon({
  edit,
  rows,
  onToggleLayer,
  onToggleFrozen,
  onToggleLocked,
  markersShown,
  onToggleMarkers,
  osm,
  layerScreen,
  view,
  layerNotice = null,
}: {
  edit: CanvasEditState;
  rows: readonly LayerRow[];
  onToggleLayer: (index: number) => void;
  onToggleFrozen: (index: number) => void;
  onToggleLocked: (index: number) => void;
  /** The error markers are drawn; the strip button hides / shows them. */
  markersShown: boolean;
  onToggleMarkers: () => void;
  /** OpenStreetMap behind the drawing: needs the file's CRS; loaded only when turned on. */
  osm: { available: boolean; shown: boolean; onToggle: () => void };
  layerScreen: LayerScreen;
  /** The view buttons and palettes on the tab strip. */
  view: StripView;
  /** Why the last layer change was refused (the current layer cannot be frozen). */
  layerNotice?: string | null;
}) {
  const { t } = useI18n();
  const editing = edit.available && edit.editing;
  // Items 31 + 31b: every panel gets the same share of the ribbon's width; recomputed on resize.
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const refit = useCallback(() => {
    const row = rowRef.current;
    if (row) setRowWidth(row.clientWidth);
  }, []);
  useLayoutEffect(() => {
    refit();
  });
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refit);
    observer.observe(row);
    return () => observer.disconnect();
  }, [refit, editing]);
  const share = panelShare(rowWidth, PANEL_SHARES);
  const fit = useMemo(() => ({ share }), [share]);
  return (
    <div
      role="toolbar"
      aria-label={t('design.cad.ribbon')}
      dir="ltr"
      className={`flex flex-col border ${DARK.bar}`}
    >
      <TabStrip
        edit={edit}
        markersShown={markersShown}
        onToggleMarkers={onToggleMarkers}
        view={view}
      />
      {editing ? (
        <RibbonFit.Provider value={fit}>
          <HatchCreationTab edit={edit} />
          <div
            ref={rowRef}
            hidden={edit.hatch !== null}
            className="flex flex-nowrap items-stretch py-1.5"
          >
            <Panel
              id="draw"
              title={t('design.cad.panel.draw')}
              more={
                <>
                  <Variant
                    edit={edit}
                    id="spline"
                    option="F"
                    label={t('design.cad.tool.splineFit')}
                  />
                  <Variant
                    edit={edit}
                    id="spline"
                    option="CV"
                    label={t('design.cad.tool.splineCv')}
                  />
                  <Tile edit={edit} id="ray" />
                  <Tile edit={edit} id="xline" />
                  <Variant
                    edit={edit}
                    id="point"
                    option="M"
                    label={t('design.cad.tool.multiplePoints')}
                  />
                  <Tile edit={edit} id="divide" />
                  <Tile edit={edit} id="measure" />
                  <Tile edit={edit} id="region" />
                  <Tile edit={edit} id="wipeout" />
                  <Tile edit={edit} id="helix" />
                  <Tile edit={edit} id="donut" />
                  <Tile edit={edit} id="polygon" />
                </>
              }
            >
              <Rows>
                <Tile edit={edit} id="line" />
                <Tile edit={edit} id="pline" />
                <Tile edit={edit} id="circle" />
                <Tile edit={edit} id="arc" />
                <Tile edit={edit} id="rectang" />
                <SplitTool
                  edit={edit}
                  label={t('design.cad.tool.hatch')}
                  icon="hatch"
                  items={[
                    { label: t('design.cad.tool.hatch'), icon: 'hatch', id: 'hatch' },
                    { label: t('design.cad.tool.gradient'), icon: 'gradient', id: 'gradient' },
                    { label: t('design.cad.tool.boundary'), icon: 'boundary', id: 'boundary' },
                  ]}
                />
                <SplitTool
                  edit={edit}
                  label={t('design.cad.tool.ellipse')}
                  icon="ellipse"
                  items={[
                    {
                      label: t('design.cad.tool.ellipseCenter'),
                      icon: 'ellipse',
                      id: 'ellipse',
                      option: 'C',
                    },
                    { label: t('design.cad.tool.ellipseAxis'), icon: 'ellipse', id: 'ellipse' },
                    {
                      label: t('design.cad.tool.ellipseArc'),
                      icon: 'arc',
                      id: 'ellipse',
                      option: 'A',
                    },
                  ]}
                />
                <Tile edit={edit} id="point" />
              </Rows>
            </Panel>
            <Panel
              id="modify"
              title={t('design.cad.panel.modify')}
              more={
                <>
                  <Tile edit={edit} id="extend" />
                  <Tile edit={edit} id="explode" />
                  <Tile edit={edit} id="break" />
                  <Tile edit={edit} id="breakatpoint" />
                  <Tile edit={edit} id="lengthen" />
                  <Tile edit={edit} id="reverse" />
                  <Tile edit={edit} id="arrayrect" />
                  <Tile edit={edit} id="arraypath" />
                  <Tile edit={edit} id="arraypolar" />
                  <Tile edit={edit} id="chamfer" />
                  <Tile edit={edit} id="overkill" />
                  <SplitTool
                    edit={edit}
                    label={t('design.cad.tool.draworder')}
                    icon="draworder"
                    items={[
                      {
                        label: t('design.cad.menu.bringFront'),
                        icon: 'draworder',
                        id: 'draworder',
                        option: 'F',
                      },
                      {
                        label: t('design.cad.menu.sendBack'),
                        icon: 'draworder',
                        id: 'draworder',
                        option: 'B',
                      },
                      {
                        label: t('design.cad.menu.bringAbove'),
                        icon: 'draworder',
                        id: 'draworder',
                        option: 'A',
                      },
                      {
                        label: t('design.cad.menu.sendUnder'),
                        icon: 'draworder',
                        id: 'draworder',
                        option: 'U',
                      },
                    ]}
                  />
                </>
              }
            >
              <Rows>
                <Tile edit={edit} id="move" />
                <Tile edit={edit} id="copy" />
                <Tile edit={edit} id="stretch" />
                <Tile edit={edit} id="rotate" />
                <Tile edit={edit} id="mirror" />
                <Tile edit={edit} id="scale" />
                <Tile edit={edit} id="trim" />
                <Tile edit={edit} id="fillet" />
                <Tile edit={edit} id="join" />
                <Tile edit={edit} id="erase" />
                <Tile edit={edit} id="offset" />
              </Rows>
            </Panel>
            <Panel id="annotation" title={t('design.cad.panel.annotation')}>
              <Rows>
                <Tile edit={edit} id="text" />
                <Tile edit={edit} id="dimlinear" />
                <Tile edit={edit} id="leader" />
                <Tile edit={edit} id="textedit" />
                <TableTile edit={edit} />
              </Rows>
            </Panel>
            <Panel id="text" title={t('design.cad.panel.text')}>
              <Rows>
                <ModifyText edit={edit} />
                <TextTool edit={edit} id="txt2mtxt" />
                <TextTool edit={edit} id="tcount" />
                <TextTool edit={edit} id="tcircle" />
                <TextTool edit={edit} id="textmask" />
                <TextTool edit={edit} id="textunmask" />
              </Rows>
            </Panel>
            <Panel
              id="layers"
              title={t('design.cad.panel.layers')}
              more={
                <div className="flex flex-col gap-1">
                  <LayerStates screen={layerScreen} />
                  <LockedFading screen={layerScreen} />
                </div>
              }
            >
              <div className="flex flex-col items-start gap-0">
                <Tile edit={edit} id="layer" />
                <LayerDropdown
                  edit={edit}
                  rows={rows}
                  onToggleLayer={onToggleLayer}
                  onToggleFrozen={onToggleFrozen}
                  onToggleLocked={onToggleLocked}
                  notice={layerNotice}
                />
                <button
                  type="button"
                  aria-label={t('design.cad.osm')}
                  aria-pressed={osm.shown}
                  title={osm.available ? t('design.cad.osmHint') : t('design.cad.osmNoCrs')}
                  disabled={!osm.available}
                  onClick={osm.onToggle}
                  className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-(--color-focus) disabled:opacity-40 ${
                    osm.shown ? DARK.on : DARK.tile
                  }`}
                >
                  <Svg size="size-4">{ICONS.osm}</Svg>
                  <span dir="ltr" className="whitespace-nowrap">
                    {t('design.cad.osm')}
                  </span>
                </button>
              </div>
              <Rows>
                <Tile edit={edit} id="layoff" />
                <Tile edit={edit} id="layiso" />
                <Tile edit={edit} id="layfrz" />
                <Tile edit={edit} id="laylck" />
                <Tile edit={edit} id="laymcur" />
                <Tile edit={edit} id="layon" />
                <Tile edit={edit} id="layuniso" />
                <Tile edit={edit} id="laythw" />
                <Tile edit={edit} id="layulk" />
                <Tile edit={edit} id="laymch" />
                <Tile edit={edit} id="find" />
                <Tile edit={edit} id="layerp" />
                <Tile edit={edit} id="laycur" />
                <Tile edit={edit} id="copytolayer" />
                <Tile edit={edit} id="laywalk" />
                <Tile edit={edit} id="laymrg" />
                <Tile edit={edit} id="laydel" />
              </Rows>
            </Panel>
            <Panel id="groups" title={t('design.cad.panel.groups')}>
              <Rows>
                <Tile edit={edit} id="group" />
                <Tile edit={edit} id="ungroup" />
                <Tile edit={edit} id="groupedit" />
                <button
                  type="button"
                  aria-pressed={edit.groupPick}
                  aria-label={t('design.cad.tool.pickstyle')}
                  title={`${t('design.cad.tool.pickstyle')} — PICKSTYLE`}
                  onClick={() => edit.run('pickstyle')}
                  className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs ${
                    edit.groupPick ? DARK.on : DARK.tile
                  }`}
                >
                  <Svg size="size-4">{ICONS.pickstyle}</Svg>
                  <span dir="ltr" className="whitespace-nowrap">
                    {t('design.cad.tool.pickstyle')}
                  </span>
                </button>
              </Rows>
            </Panel>
            <Panel id="block" title={t('design.cad.panel.block')}>
              <Rows>
                <Tile edit={edit} id="insert" />
                <Tile edit={edit} id="block" />
                <Tile edit={edit} id="eattedit" />
              </Rows>
            </Panel>
            <Panel id="properties" title={t('design.cad.panel.properties')}>
              <Rows>
                <Tile edit={edit} id="matchprop" />
              </Rows>
              <PropertiesControls edit={edit} />
            </Panel>
            <Panel id="utilities" title={t('design.cad.panel.utilities')}>
              <Rows>
                <SplitTool
                  edit={edit}
                  label={t('design.cad.tool.measuregeom')}
                  icon="measuregeom"
                  items={[
                    {
                      label: t('design.cad.tool.measureDistance'),
                      icon: 'measuregeom',
                      id: 'measuregeom',
                      option: 'D',
                    },
                    {
                      label: t('design.cad.tool.measureRadius'),
                      icon: 'measuregeom',
                      id: 'measuregeom',
                      option: 'R',
                    },
                    {
                      label: t('design.cad.tool.measureAngle'),
                      icon: 'measuregeom',
                      id: 'measuregeom',
                      option: 'A',
                    },
                    {
                      label: t('design.cad.tool.measureArea'),
                      icon: 'measuregeom',
                      id: 'measuregeom',
                      option: 'AR',
                    },
                  ]}
                />
                <Tile edit={edit} id="qselect" />
                <button
                  type="button"
                  aria-label={t('design.cad.tool.selectall')}
                  title={`${t('design.cad.tool.selectall')} — Ctrl+A`}
                  onClick={edit.selectAll}
                  className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs ${DARK.tile}`}
                >
                  <Svg size="size-4">{ICONS.selectall}</Svg>
                  <span dir="ltr" className="whitespace-nowrap">
                    {t('design.cad.tool.selectall')}
                  </span>
                </button>
                <Tile edit={edit} id="id" />
                <Tile edit={edit} id="list" />
              </Rows>
            </Panel>
            <Panel id="clipboard" title={t('design.cad.panel.clipboard')}>
              <Rows>
                <Tile edit={edit} id="pasteclip" />
                <Tile edit={edit} id="cutclip" />
                <Tile edit={edit} id="copyclip" />
                <Tile edit={edit} id="copybase" />
              </Rows>
            </Panel>
          </div>
        </RibbonFit.Provider>
      ) : null}
    </div>
  );
}

/** Icons of a layer's screen state, as in AutoCAD's layer list. */
function StateIcon({ kind, on }: { kind: 'on' | 'freeze' | 'lock'; on: boolean }) {
  if (kind === 'on') {
    return (
      <Svg size="size-4">
        <path d="M9 18h6M10 21h4" />
        <path
          d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.6 1 2.5h6c0-.9.2-1.7 1-2.5A6 6 0 0 0 12 3z"
          fill={on ? '#ffd54f' : 'none'}
        />
      </Svg>
    );
  }
  if (kind === 'freeze') {
    return on ? (
      <Svg size="size-4">
        <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="#81d4fa" />
      </Svg>
    ) : (
      <Svg size="size-4">
        <circle cx="12" cy="12" r="4" fill="#ffca28" stroke="#ffca28" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
      </Svg>
    );
  }
  return (
    <Svg size="size-4">
      <rect x="5" y="11" width="14" height="9" rx="1" fill={on ? '#ffca28' : 'none'} />
      <path d={on ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'} />
    </Svg>
  );
}

/**
 * AutoCAD's layer drop-down: the current layer, and the list with on / freeze / lock (screen only)
 * and the colour; choosing a layer with objects picked moves them to it, else makes it current.
 */
function LayerDropdown({
  edit,
  rows,
  onToggleLayer,
  onToggleFrozen,
  onToggleLocked,
  notice,
}: {
  edit: CanvasEditState;
  rows: readonly LayerRow[];
  onToggleLayer: (index: number) => void;
  onToggleFrozen: (index: number) => void;
  onToggleLocked: (index: number) => void;
  notice: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const byName = new Map(rows.map((row) => [row.name, row] as const));
  const names = edit.allLayers;
  // With objects picked it shows their layer, as AutoCAD (blank when they differ).
  const picked = edit.shownLayer !== edit.currentLayer;
  const current = byName.get(edit.shownLayer);
  const choose = (name: string) => {
    edit.chooseLayer(name);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('design.cad.currentLayer')}: ${(picked ? edit.shownLayer : edit.currentLayer) || t('design.cad.noLayer')}`}
        onClick={() => setOpen(!open)}
        className={`flex min-h-8 w-60 items-center gap-1.5 rounded px-2 text-xs ${DARK.field}`}
      >
        {current ? (
          <>
            <StateIcon kind="on" on={current.shown} />
            <StateIcon kind="freeze" on={current.frozen} />
            <StateIcon kind="lock" on={current.locked} />
            <span
              aria-hidden="true"
              className="inline-block size-3 shrink-0 border border-white/40"
              style={{ backgroundColor: current.color }}
            />
          </>
        ) : null}
        <span className="flex-1 truncate text-start">
          {picked ? edit.shownLayer : edit.currentLayer || t('design.cad.noLayer')}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('design.cad.layerList')}
          className={`absolute start-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded shadow-lg ${DARK.field}`}
        >
          <ul>
            {names.map((name) => {
              const row = byName.get(name);
              const usable = edit.layers.includes(name);
              return (
                <li key={name} className="flex items-center gap-1 px-1 hover:bg-white/10">
                  {row ? (
                    <>
                      <IconToggle
                        label={`${t('design.cad.on')} ${name}`}
                        pressed={row.shown}
                        onClick={() => onToggleLayer(row.index)}
                      >
                        <StateIcon kind="on" on={row.shown} />
                      </IconToggle>
                      <IconToggle
                        label={t('design.cad.freeze', { layer: name })}
                        pressed={row.frozen}
                        onClick={() => onToggleFrozen(row.index)}
                      >
                        <StateIcon kind="freeze" on={row.frozen} />
                      </IconToggle>
                      <IconToggle
                        label={t('design.cad.lock', { layer: name })}
                        pressed={row.locked}
                        onClick={() => onToggleLocked(row.index)}
                      >
                        <StateIcon kind="lock" on={row.locked} />
                      </IconToggle>
                      <span
                        aria-hidden="true"
                        className="inline-block size-3 shrink-0 border border-white/40"
                        style={{ backgroundColor: row.color }}
                      />
                    </>
                  ) : (
                    <span className="w-[5.5rem]" />
                  )}
                  <button
                    type="button"
                    onClick={() => choose(name)}
                    aria-current={name === edit.currentLayer}
                    className={`min-h-8 flex-1 truncate px-1 text-start text-xs ${
                      usable ? '' : 'opacity-60'
                    } ${name === edit.currentLayer ? 'font-bold' : ''}`}
                  >
                    {name}
                  </button>
                </li>
              );
            })}
          </ul>
          {notice ? (
            <p role="alert" className="border-t border-[#4a505a] p-1.5 text-[11px] text-[#ffb4a8]">
              {notice}
            </p>
          ) : null}
          <p className="border-t border-[#4a505a] p-1.5 text-[11px] text-[#aab0b8]" dir="auto">
            {t('design.cad.screenLayers')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function IconToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="flex min-h-8 min-w-7 items-center justify-center rounded hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/**
 * AutoCAD's Properties panel (owner 2026-11-26, item 34): Object Color, Linetype, Lineweight,
 * Transparency and List. With objects picked they change those objects (set_style, saved as notes
 * the build ignores) and show how the first one is drawn (its own colour in the file too); with
 * nothing picked they set the current properties new objects are drawn with.
 */
function PropertiesControls({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const picked = edit.selectionStyle;
  const style = picked ?? edit.currentStyle;
  const title = picked ? t('design.cad.screenOnly') : t('design.cad.currentStyle');
  const hasList = 'list' in COMMANDS;
  const transparency = edit.currentStyle.transparency;
  return (
    <div className="flex gap-1">
      <div className="flex flex-col gap-1">
        <ColorPicker
          value={style.color}
          title={title}
          onChange={(color) => edit.setStyle({ color })}
        />
        <LinetypePicker
          value={style.linetype}
          title={title}
          onChange={(linetype) => edit.setStyle({ linetype })}
          onCurrent={(linetype) => edit.setCurrentStyle({ linetype })}
        />
        <LineweightPicker
          value={style.lineweight}
          title={title}
          onChange={(lineweight) => edit.setStyle({ lineweight })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <div
          className="flex min-h-7 items-center gap-1 text-xs"
          title={picked ? t('design.cad.transparencyNo') : t('design.cad.currentStyle')}
        >
          <Svg size="size-4">{ICONS.fade}</Svg>
          <input
            type="range"
            min={0}
            max={90}
            step={1}
            disabled={picked !== null}
            value={transparency ?? 0}
            aria-label={t('design.cad.transparency')}
            onChange={(event) => edit.setCurrentStyle({ transparency: Number(event.target.value) })}
            className="w-20 disabled:opacity-40"
          />
          <button
            type="button"
            disabled={picked !== null}
            onClick={() => edit.setCurrentStyle({ transparency: null })}
            className={`min-w-12 rounded px-1 text-end disabled:opacity-40 ${DARK.tile}`}
            dir="ltr"
          >
            {transparency === null ? t('design.cad.byLayer') : String(transparency)}
          </button>
        </div>
        <button
          type="button"
          aria-label={t('design.cad.list')}
          title={hasList ? `${t('design.cad.list')} — LIST (LI)` : t('design.cad.listSoon')}
          disabled={!hasList}
          onClick={() => edit.run('list' as CommandId)}
          className={`flex min-h-7 items-center gap-1.5 rounded px-1.5 text-xs disabled:opacity-40 ${DARK.tile}`}
        >
          <Svg size="size-4">
            <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
          </Svg>
          <span dir="ltr">{t('design.cad.list')}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * AutoCAD's command line under the canvas: the last lines, the prompt of the command (its option
 * words can be clicked) and the entry. Enter or Space confirms, Esc cancels.
 */
export function CadCommandLine({
  edit,
  historyOpen = false,
  onToggleHistory,
}: {
  edit: CanvasEditState;
  /** F2: AutoCAD's text window with the whole history above the line. */
  historyOpen?: boolean;
  onToggleHistory?: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const { focusNonce } = edit;
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus({ preventScroll: true });
  }, [focusNonce]);
  // AutoComplete (item 33): the highlighted suggestion; ↑ / ↓ recall (position in recentInput).
  const [highlight, setHighlight] = useState(0);
  const [recall, setRecall] = useState<number | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const typed = edit.input;
  const [typedBefore, setTypedBefore] = useState(typed);
  if (typed !== typedBefore) {
    setTypedBefore(typed);
    setHighlight(0);
  }
  if (!edit.available || !edit.editing) return null;
  const name = edit.commandLabel ?? (edit.command ? COMMANDS[edit.command].name : null);
  const { prompt } = edit;
  const suggestions =
    prompt.key === 'command' && name === null && recall === null ? suggestCommands(typed) : [];
  const listed = Math.min(highlight, Math.max(0, suggestions.length - 1));
  const recallTo = (index: number | null) => {
    setRecall(index);
    edit.setInput(index === null ? '' : (edit.recentInput[index] ?? ''));
  };
  const start = (id: CommandId) => {
    setRecentOpen(false);
    setRecall(null);
    edit.run(id);
  };
  const text = t(`design.cad.cmd.${prompt.key}` as MessageKey);
  // AutoCAD's floating command line: a translucent grey bar over the bottom of the drawing, the
  // last lines fading above it; the text keeps a shadow so it reads on any drawing (owner 2026-11-26).
  const lines = historyOpen ? edit.history : edit.history.slice(-3);
  return (
    <div
      role="group"
      aria-label={t('design.cad.commandLine')}
      dir="ltr"
      data-testid="cad-command-line"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col pe-4 font-mono text-xs text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]"
    >
      <div
        role="log"
        aria-label={t('design.cad.history')}
        className={`px-2 pt-1 ${
          historyOpen
            ? 'pointer-events-auto max-h-[50vh] overflow-y-auto bg-[#22262c]/75'
            : 'bg-gradient-to-t from-[#22262c]/45 to-transparent opacity-90'
        }`}
      >
        {lines.map((line, i) => (
          <div
            key={`${edit.history.length}-${i}`}
            dir="auto"
            className={`text-start ${historyOpen ? 'whitespace-pre-wrap' : 'truncate'}`}
          >
            {line}
          </div>
        ))}
      </div>
      <div
        onContextMenu={(event) => {
          // AutoCAD: right-click on the command line lists the recent commands.
          event.preventDefault();
          setRecentOpen((open) => !open);
        }}
        className="pointer-events-auto relative flex flex-wrap items-center gap-2 border-t border-white/10 bg-[#22262c]/60 px-2 py-1.5"
      >
        {suggestions.length > 0 ? (
          <ul
            id="cad-suggestions"
            role="listbox"
            aria-label={t('design.cad.suggestions')}
            className="absolute start-8 bottom-full z-20 mb-0.5 max-h-72 min-w-52 overflow-y-auto rounded border border-[#4a505a] bg-[#2b2f36] py-0.5 shadow-lg [text-shadow:none]"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.id}
                id={`cad-suggestion-${s.id}`}
                role="option"
                aria-selected={i === listed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => start(s.id)}
                className={`cursor-default px-2 py-0.5 ${
                  i === listed ? 'bg-[#3d6fb6] text-white' : 'text-[#e8eaed] hover:bg-white/10'
                }`}
              >
                {s.label}
              </li>
            ))}
          </ul>
        ) : null}
        {recentOpen ? (
          <ul
            role="menu"
            aria-label={t('design.cad.recentCommands')}
            className="absolute start-0 bottom-full z-20 mb-0.5 min-w-52 rounded border border-[#4a505a] bg-[#2b2f36] py-1 font-sans shadow-lg [text-shadow:none]"
          >
            <li role="presentation" className="px-2 pb-1 text-[11px] text-[#aab0b8]" dir="auto">
              {t('design.cad.recentCommands')}
            </li>
            {edit.recentCommands.length === 0 ? (
              <li role="presentation" className="px-2 text-[#aab0b8]" dir="auto">
                {t('design.cad.noRecentCommands')}
              </li>
            ) : (
              edit.recentCommands.map((id) => (
                <li key={id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => start(id)}
                    className="flex min-h-7 w-full items-center px-2 text-start font-mono hover:bg-white/10"
                  >
                    {COMMANDS[id].name}
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
        <button
          type="button"
          aria-label={t('design.cad.strip.history')}
          title={t('design.cad.strip.history')}
          aria-pressed={historyOpen}
          onClick={onToggleHistory}
          className="rounded px-1 text-[#9cc4ff] hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-(--color-focus)"
        >
          <span aria-hidden="true">{name ? '▸' : '⌨'}</span>
        </button>
        <span data-testid="cad-prompt" aria-live="polite">
          {prompt.key === 'command' ? (
            text
          ) : (
            <>
              {name} {text}
              {prompt.options.length > 0 ? (
                <>
                  {' '}
                  {PROMPTS_WITHOUT_OR.has(prompt.key) ? '' : `${t('design.cad.or')} `}[
                  {prompt.options.map((o, i) => (
                    <span key={o.key}>
                      {i > 0 ? '/' : ''}
                      <button
                        type="button"
                        className="text-[#7fb2ff] underline-offset-2 hover:underline"
                        onClick={() => edit.chooseOption(o.key)}
                      >
                        {o.word}
                      </button>
                    </span>
                  ))}
                  ]
                </>
              ) : null}
              {prompt.fallback !== null ? ` <${prompt.fallback}>` : ''}:
            </>
          )}
        </span>
        <input
          ref={inputRef}
          aria-label={t('design.cad.commandInput')}
          title={formatPrompt(t, name, prompt)}
          value={edit.input}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="cad-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={
            suggestions[listed] ? `cad-suggestion-${suggestions[listed].id}` : undefined
          }
          onChange={(event) => {
            setRecall(null);
            edit.setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            const ctrl = event.ctrlKey || event.metaKey;
            if (event.key === 'Delete' && edit.input === '' && edit.key('Delete', false)) {
              event.preventDefault();
              return;
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              const up = event.key === 'ArrowUp';
              if (suggestions.length > 0) {
                // AutoCAD: the arrows walk the suggestion list.
                event.preventDefault();
                const n = suggestions.length;
                setHighlight((listed + (up ? n - 1 : 1)) % n);
                return;
              }
              const count = edit.recentInput.length;
              if (count === 0 || (edit.input !== '' && recall === null)) return;
              // On an empty line the arrows recall what was typed before (AutoCAD).
              event.preventDefault();
              if (up) recallTo(recall === null ? count - 1 : Math.max(0, recall - 1));
              else recallTo(recall === null || recall + 1 >= count ? null : recall + 1);
              return;
            }
            if (event.key === 'Escape') {
              setRecentOpen(false);
              setRecall(null);
            }
            const picked = suggestions[listed];
            if (picked && listed > 0 && (event.key === 'Enter' || event.key === ' ')) {
              // Enter / Space takes the highlighted suggestion (the first one goes as typed).
              event.preventDefault();
              start(picked.id);
              return;
            }
            if (event.key === 'Enter' || event.key === ' ') setRecall(null);
            if (
              event.key === 'Enter' ||
              event.key === 'Escape' ||
              (event.key === ' ' && !edit.textEntry) ||
              (ctrl && ['z', 'y'].includes(event.key.toLowerCase()) && edit.input === '')
            ) {
              event.preventDefault();
              edit.key(event.key, ctrl);
            }
          }}
          data-cad-input="true"
          className="min-h-8 min-w-48 flex-1 bg-transparent px-1 text-[#ffffff] outline-none placeholder:text-[#c4c9d0]"
        />
        {edit.edits.length > 0 ? (
          <span className="font-sans opacity-80" dir="auto">
            {t('design.edit.unsaved', { count: ltr(edit.edits.length) })}
          </span>
        ) : null}
      </div>
      {edit.error ? (
        <div className="pointer-events-auto bg-[#22262c]/70 px-2 pb-2 font-sans" dir="auto">
          <Notice kind="error">{t(edit.error.key, edit.error.params)}</Notice>
        </div>
      ) : null}
    </div>
  );
}
