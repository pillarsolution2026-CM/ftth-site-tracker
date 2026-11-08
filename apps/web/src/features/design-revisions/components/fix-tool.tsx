'use client';

import type { DrawingProblemCode, DrawingProblemItem } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useFixForm, type FixForm, type FixTools } from '../hooks/use-fix-tools';

/**
 * The fix tool of one problem place (ADR-038): one tool per problem code. A place already answered
 * by a correction in force shows "fixed, gone after the rebuild" in words with a check mark.
 */
export function FixTool({
  code,
  place,
  tools,
}: {
  code: DrawingProblemCode;
  place: DrawingProblemItem;
  tools: FixTools;
}) {
  const { t } = useI18n();
  const form = useFixForm(code, place, tools);
  if (!tools.enabled) return null;
  if (tools.isPending(code, place.handle)) {
    return (
      <p className="mt-2 text-sm font-semibold">
        <span aria-hidden="true">✔ </span>
        {t('design.fix.pending')}
      </p>
    );
  }
  if (form.tool === 'none') {
    return <p className="mt-2 text-sm">{t('design.fix.inAutocad')}</p>;
  }
  const id = `fix-${code}-${place.handle}`;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Button
        variant="outline"
        aria-expanded={form.open}
        aria-controls={`${id}-form`}
        onClick={form.toggle}
      >
        {form.open ? t('design.fix.close') : t('design.fix.open')}
      </Button>
      {form.open ? (
        <div
          id={`${id}-form`}
          className="flex flex-col gap-3 rounded-md border border-(--color-border) p-3"
        >
          <FixFields id={id} place={place} form={form} tools={tools} />
          {form.error ? <Notice kind="error">{t(form.error.key, form.error.params)}</Notice> : null}
        </div>
      ) : null}
    </div>
  );
}

function FixFields({
  id,
  place,
  form,
  tools,
}: {
  id: string;
  place: DrawingProblemItem;
  form: FixForm;
  tools: FixTools;
}) {
  const { t } = useI18n();
  const saveLabel = form.saving ? t('design.fix.saving') : undefined;
  switch (form.tool) {
    case 'move_layer':
      return (
        <>
          {place.suggestedLayer ? (
            <Button onClick={form.moveSuggested} disabled={form.saving}>
              {saveLabel ?? (
                <>
                  {t('design.fix.moveSuggested')}:{' '}
                  <Ltr className="ms-1 break-all">{place.suggestedLayer}</Ltr>
                </>
              )}
            </Button>
          ) : null}
          <LayerPicker
            id={`${id}-layer`}
            label={t('design.fix.otherLayer')}
            value={form.layer}
            onChange={form.setLayer}
            options={form.moveLayers.map((name) => ({ value: name, label: name }))}
          />
          <Button
            variant="outline"
            onClick={form.moveToLayer}
            disabled={form.saving || !form.layer}
          >
            {saveLabel ?? t('design.fix.moveToLayer')}
          </Button>
        </>
      );
    case 'add_text':
      return (
        <TextEditor
          id={id}
          label={t('design.fix.newLabel')}
          action={t('design.fix.addLabel')}
          form={form}
        />
      );
    case 'set_text':
      return (
        <TextEditor
          id={id}
          label={t('design.fix.editLabel')}
          hint={t('design.fix.lengthHint')}
          action={t('design.fix.saveLabel')}
          form={form}
        />
      );
    case 'label_type_mismatch':
      return (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{t('design.fix.mismatchChoice')}</legend>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`${id}-mode`}
                className="size-5"
                checked={form.mismatchMode === 'edit'}
                onChange={() => form.setMismatchMode('edit')}
              />
              {t('design.fix.modeEdit')}
            </label>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`${id}-mode`}
                className="size-5"
                checked={form.mismatchMode === 'item'}
                onChange={() => form.setMismatchMode('item')}
              />
              {t('design.fix.modeItem')}
            </label>
          </fieldset>
          {form.mismatchMode === 'edit' ? (
            <TextEditor
              id={id}
              label={t('design.fix.editLabel')}
              action={t('design.fix.saveLabel')}
              form={form}
            />
          ) : tools.pointLayers.length === 0 ? (
            <Notice kind="info">{t('design.fix.noPointLayers')}</Notice>
          ) : (
            <>
              <LayerPicker
                id={`${id}-item-layer`}
                label={t('design.fix.itemLayer')}
                value={form.layer}
                onChange={form.setLayer}
                options={tools.pointLayers.map((point) => ({
                  value: point.layer,
                  label: `${point.layer} — ${t(`featureType.${point.type}`)}`,
                }))}
              />
              <Button onClick={form.placeItem} disabled={form.saving || !form.layer}>
                {saveLabel ?? t('design.fix.placeItem')}
              </Button>
            </>
          )}
        </>
      );
    case 'merge_routes':
      return (
        <>
          <p className="text-sm">{t('design.fix.mergePieces', { count: form.pieces })}</p>
          <Button onClick={form.merge} disabled={form.saving || form.pieces < 2}>
            {saveLabel ?? t('design.fix.merge')}
          </Button>
        </>
      );
    case 'none':
      return null;
  }
}

function TextEditor({
  id,
  label,
  hint,
  action,
  form,
}: {
  id: string;
  label: string;
  hint?: string;
  action: string;
  form: FixForm;
}) {
  const { t } = useI18n();
  return (
    <>
      <Input
        id={`${id}-text`}
        label={label}
        dir="ltr"
        value={form.text}
        maxLength={255}
        aria-describedby={hint ? `${id}-text-hint` : undefined}
        onChange={(event) => form.setText(event.target.value)}
      />
      {hint ? (
        <p id={`${id}-text-hint`} className="text-sm opacity-80">
          {hint}
        </p>
      ) : null}
      <Button onClick={form.saveText} disabled={!form.canSubmitText}>
        {form.saving ? t('design.fix.saving') : action}
      </Button>
    </>
  );
}

function LayerPicker({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const { t } = useI18n();
  return (
    <Select id={id} label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t('design.fix.chooseLayer')}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
