'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/form-controls';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { TrenchMarksPanel } from '@/features/installation/components/trench-marks-panel';
import { useDrawingViewer, type ShowPlace } from '../hooks/use-drawing-viewer';
import { CadCommandLine, CadRibbon, PenButton } from './cad-ribbon';
import { CanvasPopover } from './canvas-popover';
import { DrawingCanvas } from './drawing-canvas';
import { LayerPanel } from './layer-panel';

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
  /** The errors work list, shown in a tab beside the drawing (ADR-050 part 3). */
  sidePanel?: ReactNode;
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
          <div className="flex flex-col gap-3 lg:flex-row">
            <div className="min-w-0 flex-1">
              <CadRibbon edit={viewer.edit} />
              <DrawingCanvas viewer={viewer} model={model}>
                <div
                  dir="ltr"
                  role="group"
                  aria-label={t('design.viewer.toolbar')}
                  className="absolute right-2 top-2 flex gap-1"
                >
                  <ToolButton label={t('design.viewer.zoomIn')} onClick={viewer.zoomIn}>
                    +
                  </ToolButton>
                  <ToolButton label={t('design.viewer.zoomOut')} onClick={viewer.zoomOut}>
                    −
                  </ToolButton>
                  <ToolButton label={t('design.viewer.fit')} onClick={viewer.fit}>
                    ⤢
                  </ToolButton>
                  <PenButton edit={viewer.edit} />
                </div>
                <CadCommandLine edit={viewer.edit} />
                <CanvasPopover viewer={viewer} />
              </DrawingCanvas>
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
            </div>
            <SideTabs
              problems={sidePanel}
              layers={
                <LayerPanel
                  rows={viewer.layerRows}
                  query={viewer.layerQuery}
                  onQuery={viewer.setLayerQuery}
                  onToggle={viewer.toggleLayer}
                  onSetListed={viewer.setShownForListed}
                />
              }
            />
          </div>
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

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      variant="outline"
      className="bg-white px-3 text-lg"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

/** Beside the drawing: the errors (when given) and the layers, as two tabs. */
function SideTabs({ problems, layers }: { problems?: ReactNode; layers: ReactNode }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'problems' | 'layers'>(problems ? 'problems' : 'layers');
  if (!problems) return <div className="lg:w-72 lg:shrink-0">{layers}</div>;
  const tabs = [
    { key: 'problems', label: t('design.problems.title') },
    { key: 'layers', label: t('design.viewer.layersTab') },
  ] as const;
  return (
    <div className="flex flex-col gap-2 lg:w-96 lg:shrink-0">
      <div role="tablist" aria-label={t('design.viewer.sideTabs')} className="flex gap-1">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`side-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={`side-panel-${item.key}`}
            onClick={() => setTab(item.key)}
            className={`min-h-10 flex-1 rounded-t-md border-b-2 px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
              tab === item.key ? 'border-(--color-brand)' : 'border-transparent opacity-70'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`side-panel-${tab}`}
        aria-labelledby={`side-tab-${tab}`}
        className="max-h-[75vh] overflow-y-auto pe-1"
      >
        {tab === 'problems' ? problems : layers}
      </div>
    </div>
  );
}
