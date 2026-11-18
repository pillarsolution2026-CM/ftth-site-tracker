'use client';

import { useState, type ReactNode } from 'react';
import { ltr } from '@ftth/i18n';
import { MAX_TEXT_LENGTH } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { CanvasEditState } from '../hooks/use-canvas-edit';
import type { EditTool } from '../model/canvas-edit';

/**
 * The CAD ribbon of the drawing (ADR-050), AutoCAD-like: Draw | Modify | Layers | Undo, Save,
 * Cancel. The pen on the canvas opens it; nothing is kept until «حفظ».
 */

/** The pen on the canvas toolbar: opens the ribbon. */
export function PenButton({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available || edit.editing) return null;
  return (
    <Button
      variant="outline"
      className="bg-white px-3 text-lg"
      aria-label={t('design.edit.start')}
      title={t('design.edit.start')}
      onClick={edit.start}
    >
      <span aria-hidden="true">✎</span>
    </Button>
  );
}

const ICONS: Record<EditTool | 'undo', ReactNode> = {
  line: <path d="M4 20 20 4" />,
  polyline: <path d="M3 19 9 9l6 6 6-11" />,
  addText: <path d="M5 5h14M12 5v14M9 19h6" />,
  point: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    </>
  ),
  move: (
    <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="1" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  rotate: <path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5" />,
  mirror: <path d="M12 3v18M9 6 4 12l5 6M15 6l5 6-5 6" />,
  scale: (
    <>
      <rect x="3" y="11" width="10" height="10" />
      <path d="M13 11 21 3M15 3h6v6" />
    </>
  ),
  erase: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  layer: <path d="M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5" />,
  text: <path d="M4 20h4l11-11-4-4L4 16v4zM14 6l4 4" />,
  undo: <path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" />,
};

function Icon({ name }: { name: EditTool | 'undo' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

const SHORTCUT: Partial<Record<EditTool, string>> = {
  move: 'M',
  copy: 'C',
  rotate: 'R',
  mirror: 'I',
  scale: 'S',
  erase: 'E',
  line: 'L',
  polyline: 'P',
  addText: 'T',
};

function ToolTile({ edit, tool }: { edit: CanvasEditState; tool: EditTool }) {
  const { t } = useI18n();
  const on = edit.tool === tool;
  const key = SHORTCUT[tool];
  const label = t(`design.cad.tool.${tool}`);
  return (
    <button
      type="button"
      aria-pressed={on}
      title={key ? `${label} (${key})` : label}
      onClick={() => edit.setTool(on ? null : tool)}
      className={`flex min-h-11 min-w-14 flex-col items-center justify-center gap-0.5 rounded px-1.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
        on
          ? 'bg-(--color-brand) text-(--color-brandContrast)'
          : 'text-(--color-text) hover:bg-black/5 dark:hover:bg-white/10'
      }`}
    >
      <Icon name={tool} />
      <span>{label}</span>
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={title}
      className="flex flex-col border-e border-(--color-border) px-2 last:border-e-0"
    >
      <div className="flex flex-wrap items-start gap-1">{children}</div>
      <div className="mt-1 text-center text-[11px] opacity-70">{title}</div>
    </div>
  );
}

export function CadRibbon({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available || !edit.editing) return null;
  const count = edit.edits.length;
  return (
    <div
      role="toolbar"
      aria-label={t('design.cad.ribbon')}
      className="mb-2 flex flex-wrap items-stretch gap-y-2 rounded-md border border-(--color-border) bg-(--color-surface) py-2"
    >
      <Group title={t('design.cad.group.draw')}>
        {(['line', 'polyline', 'addText', 'point'] as const).map((tool) => (
          <ToolTile key={tool} edit={edit} tool={tool} />
        ))}
      </Group>
      <Group title={t('design.cad.group.modify')}>
        {(['move', 'copy', 'rotate', 'mirror', 'scale', 'erase', 'layer', 'text'] as const).map(
          (tool) => (
            <ToolTile key={tool} edit={edit} tool={tool} />
          ),
        )}
      </Group>
      <Group title={t('design.cad.group.layers')}>
        <LayersGroup edit={edit} />
      </Group>
      <div className="ms-auto flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={edit.undo}
          disabled={!edit.canUndo}
          title={`${t('design.cad.undo')} (Ctrl+Z)`}
          className="flex min-h-11 min-w-14 flex-col items-center justify-center rounded px-1.5 text-xs disabled:opacity-40"
        >
          <Icon name="undo" />
          <span>{t('design.cad.undo')}</span>
        </button>
        <Button variant="outline" onClick={edit.cancel} disabled={edit.saving}>
          <span aria-hidden="true">✕ </span>
          {t('design.edit.cancel')}
        </Button>
        <Button onClick={edit.save} disabled={edit.saving} title={t('design.edit.saveHint')}>
          <span aria-hidden="true">💾 </span>
          {edit.saving
            ? t('design.edit.saving')
            : count > 0
              ? t('design.edit.saveCount', { count: ltr(count) })
              : t('design.edit.done')}
        </Button>
      </div>
    </div>
  );
}

type LayerDialog = 'add' | 'rename' | 'delete' | null;

function LayersGroup({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<LayerDialog>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const open = (next: LayerDialog) => {
    setDialog(dialog === next ? null : next);
    setName('');
    setSource('');
    setMessage(null);
  };
  const done = (error: string | null) => {
    if (error) setMessage(error);
    else setDialog(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <Select
        id="cad-current-layer"
        label={t('design.cad.currentLayer')}
        value={edit.currentLayer}
        onChange={(event) => edit.setCurrentLayer(event.target.value)}
        className="min-w-44"
      >
        <option value="">{t('design.fix.chooseLayer')}</option>
        {edit.layers.map((layer) => (
          <option key={layer} value={layer}>
            {layer}
          </option>
        ))}
      </Select>
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('add')}>
          + {t('design.cad.layerAdd')}
        </Button>
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('rename')}>
          {t('design.cad.layerRename')}
        </Button>
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('delete')}>
          {t('design.cad.layerDelete')}
        </Button>
      </div>
      {dialog !== null ? (
        <div
          role="dialog"
          aria-label={t(`design.cad.layerDialog.${dialog}`)}
          className="flex flex-col gap-2 rounded-md border border-(--color-border) p-2"
        >
          <p className="text-sm font-semibold">{t(`design.cad.layerDialog.${dialog}`)}</p>
          {dialog === 'add' ? (
            <>
              <Input
                id="cad-layer-name"
                label={t('design.cad.layerName')}
                dir="ltr"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Select
                id="cad-layer-like"
                label={t('design.cad.layerLike')}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t('design.fix.chooseLayer')}</option>
                {edit.layers.map((layer) => (
                  <option key={layer} value={layer}>
                    {layer}
                  </option>
                ))}
              </Select>
              <Button onClick={() => done(edit.addLayer(name, source))}>
                {t('design.cad.layerAddConfirm')}
              </Button>
            </>
          ) : (
            <>
              <Select
                id="cad-layer-source"
                label={t('design.cad.layerPick')}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t('design.fix.chooseLayer')}</option>
                {edit.allLayers.map((layer) => (
                  <option key={layer} value={layer}>
                    {layer}
                  </option>
                ))}
              </Select>
              {dialog === 'rename' ? (
                <>
                  <Input
                    id="cad-layer-new-name"
                    label={t('design.cad.layerNewName')}
                    dir="ltr"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Button onClick={() => done(edit.renameLayer(source, name))}>
                    {t('design.cad.layerRenameConfirm')}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm">{t('design.cad.layerDeleteWarn')}</p>
                  <Button
                    disabled={source === ''}
                    onClick={() => {
                      edit.deleteLayer(source);
                      setDialog(null);
                    }}
                  >
                    {t('design.cad.layerDeleteConfirm')}
                  </Button>
                </>
              )}
            </>
          )}
          {message ? <Notice kind="error">{t(message as 'design.cad.layerExists')}</Notice> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The command line at the bottom of the canvas (AutoCAD's): what the command waits for, and the
 * value to type when it needs one.
 */
export function CadCommandLine({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available || !edit.editing) return null;
  return (
    <div
      className="absolute inset-x-2 bottom-7 flex flex-wrap items-center gap-2 rounded-md border border-(--color-border) bg-white/95 px-3 py-2 text-sm text-black shadow"
      aria-live="polite"
    >
      <span className="font-mono opacity-60" aria-hidden="true">
        &gt;
      </span>
      <span data-testid="cad-prompt">
        {t(`design.cad.prompt.${edit.prompt}`, { count: ltr(edit.chosenCount) })}
      </span>
      <CommandInputs edit={edit} />
      {edit.edits.length > 0 ? (
        <span className="ms-auto opacity-70">
          {t('design.edit.unsaved', { count: ltr(edit.edits.length) })}
        </span>
      ) : null}
      {edit.error ? (
        <div className="w-full">
          <Notice kind="error">{t(edit.error.key, edit.error.params)}</Notice>
        </div>
      ) : null}
    </div>
  );
}

function CommandInputs({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const enter = (run: () => void) => (event: { key: string }) => {
    if (event.key === 'Enter') run();
  };
  switch (edit.prompt) {
    case 'pick':
      return edit.chosenCount > 0 && edit.tool !== 'layer' ? (
        <Button className="min-h-9 px-3" onClick={edit.confirmPick}>
          {t('design.cad.next')}
        </Button>
      ) : null;
    case 'erase':
      return (
        <Button className="min-h-9 px-3" onClick={edit.confirmPick}>
          {t('design.cad.eraseConfirm', { count: ltr(edit.chosenCount) })}
        </Button>
      );
    case 'pickLayer':
      return (
        <>
          <Select
            id="edit-layer"
            label={t('design.edit.newLayer')}
            value={edit.layer}
            onChange={(event) => edit.setLayer(event.target.value)}
          >
            <option value="">{t('design.fix.chooseLayer')}</option>
            {edit.layers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Button className="min-h-9 px-3" onClick={edit.applyLayer} disabled={edit.layer === ''}>
            {t('design.edit.applyLayer')}
          </Button>
        </>
      );
    case 'pickText':
      return edit.chosenCount > 0 ? <TextInput edit={edit} /> : null;
    case 'textValue':
      return <TextInput edit={edit} />;
    case 'rotateTo':
      return (
        <>
          <Input
            id="edit-angle"
            label={t('design.edit.angle')}
            dir="ltr"
            inputMode="decimal"
            value={edit.angle}
            onChange={(event) => edit.setAngle(event.target.value)}
            onKeyDown={enter(edit.applyAngle)}
          />
          <Button className="min-h-9 px-3" onClick={edit.applyAngle} disabled={!edit.canApplyAngle}>
            {t('design.edit.applyAngle')}
          </Button>
        </>
      );
    case 'scaleBy':
      return (
        <>
          <Input
            id="edit-factor"
            label={t('design.cad.factor')}
            dir="ltr"
            inputMode="decimal"
            value={edit.factor}
            onChange={(event) => edit.setFactor(event.target.value)}
            onKeyDown={enter(edit.applyFactor)}
          />
          <Button
            className="min-h-9 px-3"
            onClick={edit.applyFactor}
            disabled={!edit.canApplyFactor}
          >
            {t('design.cad.applyScale')}
          </Button>
        </>
      );
    case 'polyNext':
      return (
        <>
          <Button
            className="min-h-9 px-3"
            onClick={() => edit.finishPolyline(false)}
            disabled={edit.pointsCount < 2}
          >
            {t('design.cad.finish')}
          </Button>
          <Button
            variant="outline"
            className="min-h-9 px-3"
            onClick={() => edit.finishPolyline(true)}
            disabled={edit.pointsCount < 3}
          >
            {t('design.cad.close')}
          </Button>
        </>
      );
    default:
      return null;
  }
}

function TextInput({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  return (
    <>
      <Input
        id="edit-text"
        label={t('design.edit.newText')}
        dir="ltr"
        value={edit.text}
        maxLength={MAX_TEXT_LENGTH}
        onChange={(event) => edit.setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') edit.applyText();
        }}
      />
      <Button className="min-h-9 px-3" onClick={edit.applyText} disabled={edit.text.trim() === ''}>
        {t('design.edit.applyText')}
      </Button>
    </>
  );
}
