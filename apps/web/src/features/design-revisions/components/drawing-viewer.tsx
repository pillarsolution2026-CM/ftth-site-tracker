'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/form-controls';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { TrenchMarksPanel } from '@/features/installation/components/trench-marks-panel';
import { useDrawingViewer, type ShowPlace } from '../hooks/use-drawing-viewer';
import { useCrosshairSize } from '../hooks/use-crosshair-size';
import { CadCommandLine, CadRibbon } from './cad-ribbon';
import { DraftingOverlay } from './drafting-overlay';
import { CadStatusBar } from './status-bar';
import { CanvasPopover } from './canvas-popover';
import { DrawingCanvas } from './drawing-canvas';
import { LayerManager } from './layer-panel';
import { PropertiesPalette } from './properties-palette';
import { cadShortcut } from '../model/cad-shortcuts';
import { WorkspaceDialogs } from './workspace-dialogs';

/**
 * «عارض الرسومات» (ADR-039): the drawing as drawn, with the layers, the problem places and the
 * corrections in force previewed on top. The official result is still the rebuild.
 */
export function DrawingViewer({
  projectId,
  revisionId,
  cadFileId,
  enabled,
  canWrite,
  canFix,
  isGeneral = false,
  isSecondary = false,
  onShowOnDrawing,
  onUnsavedChange,
  sidePanel,
  correctionsPanel,
  focus,
}: {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  enabled: boolean;
  /** design:write — may ask for the view to be prepared. */
  canWrite: boolean;
  /** Draft and design:write — the fix tools show in the floating panel. */
  canFix: boolean;
  /** The drawing is a General: «حفر جديد» and its trench marks (ADR-042). */
  isGeneral?: boolean;
  /** The drawing is a Secondary: the type text next to each box (ADR-043). */
  isSecondary?: boolean;
  onShowOnDrawing?: (place: Omit<ShowPlace, 'nonce'>) => void;
  /** Number of unsaved edits of the edit mode (ADR-047): the page's refresh waits for «حفظ». */
  onUnsavedChange?: (count: number) => void;
  /** The errors work list, a palette beside the drawing (ADR-050 part 3, ADR-051). */
  sidePanel?: ReactNode;
  /** The corrections table, a palette beside the drawing (ADR-051). */
  correctionsPanel?: ReactNode;
  focus: ShowPlace | null;
}) {
  const { t } = useI18n();
  const viewer = useDrawingViewer({
    projectId,
    revisionId,
    cadFileId,
    enabled,
    canWrite,
    canFix,
    isGeneral,
    isSecondary,
    focus,
  });
  const sectionRef = useRef<HTMLElement>(null);
  const nonce = focus?.nonce ?? null;
  useEffect(() => {
    if (nonce !== null)
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [nonce]);
  const unsaved = viewer.edit.edits.length;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);

  const { status, model } = viewer;
  return (
    <section ref={sectionRef} aria-labelledby="viewer-title" className="flex flex-col gap-3">
      <h2 id="viewer-title" className="text-lg font-semibold">
        {t('design.viewer.title')}
      </h2>
      {status === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {status === 'error' || status === 'viewError' ? (
        <ErrorNotice code={viewer.errorCode ?? 'INTERNAL'} />
      ) : null}
      {status === 'none' || status === 'failed' ? (
        <div className="flex flex-col gap-2">
          {status === 'failed' ? <Notice kind="error">{t('design.viewer.failed')}</Notice> : null}
          {viewer.canRequest ? (
            <>
              <p className="text-sm">{t('design.viewer.notPrepared')}</p>
              <div>
                <Button onClick={viewer.requestView} disabled={viewer.requesting}>
                  {viewer.requesting ? t('design.viewer.preparing') : t('design.viewer.prepare')}
                </Button>
              </div>
              {viewer.errorCode ? <ErrorNotice code={viewer.errorCode} /> : null}
            </>
          ) : (
            <Notice kind="info">{t('design.viewer.askForView')}</Notice>
          )}
        </div>
      ) : null}
      {status === 'queued' ? (
        <p role="status" aria-live="polite">
          {t('design.viewer.preparing')}
        </p>
      ) : null}
      {status === 'loadingView' ? <p role="status">{t('design.viewer.loadingView')}</p> : null}
      {status === 'ready' && model ? (
        <>
          {viewer.truncated ? <Notice kind="warning">{t('design.viewer.truncated')}</Notice> : null}
          <Workspace viewer={viewer} problems={sidePanel} corrections={correctionsPanel} />
          <p className="mt-1 text-sm opacity-80">{t('design.viewer.legend')}</p>
          {viewer.trench.visible ? (
            <p className="text-sm opacity-80">{t('design.viewer.trenchLegend')}</p>
          ) : null}
          {viewer.boxTypes.available ? (
            <div className="mt-1 flex flex-col gap-1">
              <Checkbox
                id="viewer-box-types"
                label={t('design.viewer.boxTypesToggle', { count: ltr(viewer.boxTypes.count) })}
                checked={viewer.boxTypes.shown}
                onChange={(event) => viewer.boxTypes.setShown(event.target.checked)}
              />
              <p className="text-sm opacity-80">{t('design.viewer.boxTypesLegend')}</p>
            </div>
          ) : null}
          {viewer.trench.visible ? (
            <TrenchMarksPanel
              tool={viewer.trench}
              onShow={
                onShowOnDrawing
                  ? (handle) => onShowOnDrawing({ code: null, handle, x: null, y: null })
                  : undefined
              }
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type PaletteKey = 'problems' | 'corrections' | 'properties';
type DrawingViewerState = ReturnType<typeof useDrawingViewer>;

/**
 * The AutoCAD-like workspace (ADR-051): the tab strip (always) and the ribbon (edit mode), the
 * black canvas across the whole width, the command line under it, palettes (errors, corrections)
 * that open and close beside the drawing, and AutoCAD's Layer Properties Manager as a pop-up
 * (owner 2026-11-19). The view buttons sit on the tab strip (owner 2026-11-26).
 */
function Workspace({
  viewer,
  problems,
  corrections,
}: {
  viewer: DrawingViewerState;
  problems?: ReactNode;
  corrections?: ReactNode;
}) {
  const { t } = useI18n();
  // One side palette at a time (owner 2026-11-26): opening one closes the others, and the Layer
  // Properties Manager too.
  const [openKey, setOpenKey] = useState<PaletteKey | null>(problems ? 'problems' : null);
  const open = new Set<PaletteKey>(openKey ? [openKey] : []);
  // LAYER / LA and the Layers buttons open the Layer Properties Manager.
  const { layersNonce, edit, model } = viewer;
  const [managerOpen, setManagerOpen] = useState(false);
  const toggle = (key: PaletteKey, on?: boolean) => {
    const show = on ?? openKey !== key;
    setOpenKey(show ? key : null);
    if (show) setManagerOpen(false);
  };
  const toggleManager = () => {
    setManagerOpen(!managerOpen);
    if (!managerOpen) setOpenKey(null);
  };
  const [seenNonce, setSeenNonce] = useState(layersNonce);
  if (layersNonce !== seenNonce) {
    setSeenNonce(layersNonce);
    setManagerOpen(true);
    setOpenKey(null);
  }
  // Full screen (owner 2026-11-26): an in-page full window that Esc never leaves (Esc cancels the
  // command, as in AutoCAD); only its button leaves it. The browser's own F11 hides its bars.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [full]);
  // In full screen while editing the errors palette starts hidden (owner 2026-11-25); the strip
  // button shows it again.
  const fullEdit = full && edit.editing;
  const [seenFullEdit, setSeenFullEdit] = useState(fullEdit);
  if (fullEdit !== seenFullEdit) {
    setSeenFullEdit(fullEdit);
    if (fullEdit && openKey === 'problems') setOpenKey(null);
  }
  // Right-click «Properties» and Ctrl+1 open AutoCAD's Properties palette.
  const { propertiesNonce } = viewer;
  const [seenProperties, setSeenProperties] = useState(propertiesNonce);
  if (propertiesNonce !== seenProperties) {
    setSeenProperties(propertiesNonce);
    setOpenKey('properties');
    setManagerOpen(false);
  }
  const crosshair = useCrosshairSize();
  // F2 (the history window) and Ctrl+9 (the command line on / off).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandLineOn, setCommandLineOn] = useState(true);
  const palettes: { key: PaletteKey; title: string; body: ReactNode }[] = [];
  if (problems) {
    palettes.push({ key: 'problems', title: t('design.cad.palette.problems'), body: problems });
  }
  if (corrections) {
    palettes.push({
      key: 'corrections',
      title: t('design.cad.palette.corrections'),
      body: corrections,
    });
  }
  if (edit.available && viewer.scene && edit.preview) {
    palettes.push({
      key: 'properties',
      title: t('design.cad.prop.title'),
      body: (
        <PropertiesPalette
          scene={edit.scene ?? viewer.scene}
          preview={edit.preview}
          chosen={edit.chosen}
          layers={edit.layers}
          editing={edit.editing}
          onApply={edit.apply}
        />
      ),
    });
  }
  if (!model) return null;
  // Clean Screen (Ctrl+0): the ribbon and the palettes give their room to the drawing.
  const clean = viewer.drafting.cleanScreen;
  const shownPalettes = clean ? [] : palettes.filter((p) => open.has(p.key));
  return (
    <div
      data-testid="cad-workspace"
      data-full={full ? 'true' : undefined}
      onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
        // AutoCAD's keys while the canvas or the command line has the focus (item 24).
        const target = event.target as HTMLElement;
        const onCanvas = target.tagName === 'CANVAS';
        const onLine = target.dataset.cadInput === 'true';
        if (!onCanvas && !onLine) return;
        const line = onLine ? (target as HTMLInputElement) : null;
        const result = cadShortcut(event, {
          editing: edit.available && edit.editing,
          // In the command line a typed text keeps the browser's copy / paste / select-all.
          typing: line !== null && (line.value !== '' || line.selectionStart !== line.selectionEnd),
        });
        if (!result) return;
        event.preventDefault();
        event.stopPropagation();
        switch (result) {
          case 'copyclip':
          case 'cutclip':
          case 'copybase':
          case 'pasteclip':
            edit.run(result);
            break;
          case 'selectAll':
            edit.selectAll();
            break;
          case 'save':
            if (edit.edits.length > 0 && !edit.saving) edit.save();
            break;
          case 'properties':
            viewer.openProperties();
            break;
          case 'commandLine':
            setCommandLineOn(!commandLineOn);
            break;
          case 'history':
            setHistoryOpen(!historyOpen);
            break;
        }
      }}
      className={`flex flex-col ${full ? 'fixed inset-0 z-50 overflow-auto bg-[#1f2328]' : ''}`}
    >
      {clean ? null : (
        <CadRibbon
          edit={edit}
          rows={viewer.layerRows}
          onToggleLayer={viewer.toggleLayer}
          onToggleFrozen={viewer.toggleFrozen}
          onToggleLocked={viewer.toggleLocked}
          markersShown={viewer.markersShown}
          onToggleMarkers={() => viewer.setMarkersShown(!viewer.markersShown)}
          osm={{
            available: viewer.osm.toLonLat !== null,
            shown: viewer.osm.shown,
            onToggle: () => viewer.osm.setShown(!viewer.osm.shown),
          }}
          layerScreen={viewer.layerScreen}
          view={{
            zoomIn: viewer.zoomIn,
            zoomOut: viewer.zoomOut,
            fit: viewer.fit,
            full,
            onToggleFull: () => setFull(!full),
            layersOpen: managerOpen,
            onToggleLayers: toggleManager,
            palettes: palettes.map((p) => ({
              key: p.key,
              title: p.title,
              open: open.has(p.key),
              onToggle: () => toggle(p.key),
            })),
            crosshair: crosshair.size,
            onToggleCrosshair: crosshair.toggle,
          }}
        />
      )}
      <div className={`flex flex-col gap-3 lg:flex-row lg:gap-0 ${full ? 'min-h-0 flex-1' : ''}`}>
        <div className={`min-w-0 flex-1 ${full ? 'flex min-h-0 flex-col' : ''}`}>
          <div className={`relative ${full ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
            <DrawingCanvas viewer={viewer} model={model} fill={full} crosshair={crosshair.size}>
              <DraftingOverlay viewer={viewer} />
              <CanvasPopover viewer={viewer} />
              <WorkspaceDialogs viewer={viewer} />
            </DrawingCanvas>
            {commandLineOn ? (
              <CadCommandLine
                edit={edit}
                historyOpen={historyOpen}
                onToggleHistory={() => setHistoryOpen(!historyOpen)}
              />
            ) : null}
          </div>
          <CadStatusBar viewer={viewer} />
          {managerOpen && !clean ? (
            <LayerManager
              rows={viewer.layerRows}
              query={viewer.layerQuery}
              onQuery={viewer.setLayerQuery}
              onToggle={viewer.toggleLayer}
              onSetListed={viewer.setShownForListed}
              onFreeze={viewer.toggleFrozen}
              onLock={viewer.toggleLocked}
              onColor={viewer.setLayerColor}
              edit={edit.editing ? edit : null}
              onClose={() => setManagerOpen(false)}
            />
          ) : null}
        </div>
        {shownPalettes.length > 0 ? (
          <div className="relative lg:w-96 lg:shrink-0">
            {shownPalettes.map((p) => (
              <aside
                key={p.key}
                aria-label={p.title}
                data-testid="cad-palette"
                className="flex max-h-[75vh] min-h-0 flex-col rounded-md lg:absolute lg:inset-y-0 lg:start-2 lg:end-0 lg:max-h-none border border-(--color-border) bg-(--color-surface) text-(--color-text) dark:bg-(--color-surfaceDark) dark:text-(--color-textDark)"
              >
                <div className="flex items-center justify-between gap-2 border-b border-(--color-border) bg-[#2b2f36] px-2 py-1 text-[#e8eaed]">
                  <span className="text-sm font-semibold">{p.title}</span>
                  <button
                    type="button"
                    aria-label={t('design.cad.palette.close', { name: p.title })}
                    title={t('design.cad.palette.close', { name: p.title })}
                    onClick={() => toggle(p.key, false)}
                    className="min-h-8 min-w-8 rounded hover:bg-white/10"
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2 pe-1">{p.body}</div>
              </aside>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
