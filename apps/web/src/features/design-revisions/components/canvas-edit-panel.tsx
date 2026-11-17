'use client';

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
 * The pen of the drawing (ADR-047), at the top right of the canvas: it starts the edit mode and
 * then becomes «حفظ», with «إلغاء» next to it.
 */
export function EditToolbarButtons({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available) return null;
  if (!edit.editing) {
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
  const count = edit.edits.length;
  return (
    <>
      <Button
        variant="outline"
        className="bg-white"
        onClick={edit.cancel}
        disabled={edit.saving}
        title={t('design.edit.cancelHint')}
      >
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
    </>
  );
}

const TOOLS: readonly EditTool[] = ['layer', 'text', 'move', 'rotate'];

/** The tools of the edit mode and the step the user is on. */
export function EditPanel({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available || !edit.editing) return null;
  return (
    <div
      role="region"
      aria-label={t('design.edit.title')}
      className="absolute right-2 top-14 flex w-72 max-w-[calc(100%-1rem)] flex-col gap-2 rounded-md border border-(--color-border) bg-white p-3 text-black shadow-md"
    >
      <div role="group" aria-label={t('design.edit.tools')} className="flex flex-wrap gap-2">
        {TOOLS.map((tool) => (
          <Button
            key={tool}
            variant={edit.tool === tool ? 'primary' : 'outline'}
            aria-pressed={edit.tool === tool}
            onClick={() => edit.setTool(edit.tool === tool ? null : tool)}
          >
            {t(`design.edit.tool.${tool}`)}
          </Button>
        ))}
      </div>
      {edit.tool === null ? <p className="text-sm">{t('design.edit.pickTool')}</p> : null}
      {edit.tool === 'layer' ? <LayerStep edit={edit} /> : null}
      {edit.tool === 'text' ? <TextStep edit={edit} /> : null}
      {edit.tool === 'move' || edit.tool === 'rotate' ? <PointsStep edit={edit} /> : null}
      {edit.edits.length > 0 ? (
        <p className="text-sm" aria-live="polite">
          {t('design.edit.unsaved', { count: ltr(edit.edits.length) })}
        </p>
      ) : null}
      {edit.error ? <Notice kind="error">{t(edit.error.key, edit.error.params)}</Notice> : null}
    </div>
  );
}

function LayerStep({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (edit.chosenCount === 0) {
    return <p className="text-sm">{t('design.edit.pickItems')}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" aria-live="polite">
        {t('design.edit.chosen', { count: ltr(edit.chosenCount) })}
      </p>
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={edit.applyLayer} disabled={edit.layer === ''}>
          {t('design.edit.applyLayer')}
        </Button>
        <Button variant="outline" onClick={edit.clearChosen}>
          {t('design.edit.clearChosen')}
        </Button>
      </div>
    </div>
  );
}

function TextStep({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (edit.chosenCount === 0) {
    return (
      <p className="text-sm" aria-live="polite">
        {edit.notText ? t('design.edit.notText') : t('design.edit.pickText')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={edit.applyText} disabled={edit.text.trim() === ''}>
          {t('design.edit.applyText')}
        </Button>
        <Button variant="outline" onClick={edit.clearChosen}>
          {t('design.edit.clearChosen')}
        </Button>
      </div>
    </div>
  );
}

/** Move and rotate: pick, then the base point, then the second point (or a typed angle). */
function PointsStep({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (edit.step === 'base') {
    return (
      <p className="text-sm" aria-live="polite">
        {t('design.edit.pickBase')}
      </p>
    );
  }
  if (edit.step === 'second') {
    if (edit.tool === 'move') {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm" aria-live="polite">
            {t('design.edit.pickTarget')}
          </p>
          <Button variant="outline" onClick={edit.clearChosen}>
            {t('design.edit.clearChosen')}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm" aria-live="polite">
          {t('design.edit.pickAngle')}
        </p>
        <Input
          id="edit-angle"
          label={t('design.edit.angle')}
          dir="ltr"
          inputMode="decimal"
          value={edit.angle}
          onChange={(event) => edit.setAngle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') edit.applyAngle();
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={edit.applyAngle} disabled={!edit.canApplyAngle}>
            {t('design.edit.applyAngle')}
          </Button>
          <Button variant="outline" onClick={edit.clearChosen}>
            {t('design.edit.clearChosen')}
          </Button>
        </div>
      </div>
    );
  }
  if (edit.chosenCount === 0) {
    return <p className="text-sm">{t('design.edit.pickItems')}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" aria-live="polite">
        {t('design.edit.chosen', { count: ltr(edit.chosenCount) })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={edit.startPoints}>{t('design.edit.chooseBase')}</Button>
        <Button variant="outline" onClick={edit.clearChosen}>
          {t('design.edit.clearChosen')}
        </Button>
      </div>
    </div>
  );
}
