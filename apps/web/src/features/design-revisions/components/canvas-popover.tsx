'use client';

import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { effectiveLayer } from '../model/drawing-preview';
import { toScreen } from '../model/view-transform';
import { FixTool } from './fix-tool';

const PANEL_WIDTH = 320;

/**
 * The floating panel on the canvas: what the clicked entity is (handle, layer, kind) and, when a
 * problem place is there, the very same fix tool as the problems table (ADR-039).
 */
export function CanvasPopover({ viewer }: { viewer: DrawingViewer }) {
  const { t, dir } = useI18n();
  const { popover, scene, model, size, transform } = viewer;
  if (!popover || !scene || !model) return null;
  const entity = popover.entity !== null ? scene.view.entities[popover.entity] : undefined;
  const layerName =
    entity && popover.entity !== null
      ? scene.view.layers[effectiveLayer(scene, model.preview, popover.entity)]?.name
      : undefined;
  const anchor = toScreen(transform, size, popover.x, popover.y);
  const width = Math.min(PANEL_WIDTH, Math.max(160, size.width - 16));
  const left = Math.max(8, Math.min(anchor.x + 14, size.width - width - 8));
  const top = Math.max(8, Math.min(anchor.y + 14, size.height - 140));
  const marker = popover.marker;
  return (
    <div
      role="dialog"
      aria-label={t('design.viewer.popoverLabel')}
      dir={dir}
      style={{ left, top, width, maxHeight: Math.max(120, size.height - top - 8) }}
      className="absolute z-10 flex flex-col gap-2 overflow-y-auto rounded-md border-2 border-(--color-border) bg-white p-3 text-sm text-black shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') viewer.closePopover();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">
          {marker ? t(`design.problems.code.${marker.code}`) : t('design.viewer.entityInfo')}
        </h3>
        <Button
          variant="outline"
          className="px-2"
          aria-label={t('design.viewer.closePopover')}
          onClick={viewer.closePopover}
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        {entity ? (
          <>
            <dt className="font-semibold">{t('design.problems.handle')}</dt>
            <dd>
              <Ltr>{entity.handle}</Ltr>
            </dd>
            <dt className="font-semibold">{t('design.viewer.entityLayer')}</dt>
            <dd>
              <Ltr className="break-all">{layerName ?? '—'}</Ltr>
            </dd>
            <dt className="font-semibold">{t('design.viewer.entityKind')}</dt>
            <dd>
              <Ltr>{entity.kind}</Ltr>
            </dd>
            {entity.texts[0] ? (
              <>
                <dt className="font-semibold">{t('design.problems.label')}</dt>
                <dd>
                  <Ltr className="break-all">{entity.texts[0].text}</Ltr>
                </dd>
              </>
            ) : null}
          </>
        ) : marker ? (
          <>
            <dt className="font-semibold">{t('design.problems.handle')}</dt>
            <dd>
              <Ltr>{marker.handle}</Ltr>
            </dd>
            <dt className="font-semibold">{t('design.problems.layer')}</dt>
            <dd>
              <Ltr className="break-all">{marker.item.layer}</Ltr>
            </dd>
          </>
        ) : null}
      </dl>
      {marker ? (
        <div>
          {entity ? (
            <p className="font-semibold">{t(`design.problems.code.${marker.code}`)}</p>
          ) : null}
          <FixTool
            key={marker.key}
            code={marker.code}
            place={marker.item}
            tools={viewer.tools}
            defaultOpen
          />
        </div>
      ) : null}
    </div>
  );
}
