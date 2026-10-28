'use client';

import { MAPPING_TEXT_ROWS_LIMIT, type CadMappingInput, type CadMappingView } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useMappingForm } from '../hooks/use-mapping-form';
import { CrsPanel } from './crs-panel';
import { BlockRulesTable, LayerRulesTable, TextRulesTable } from './rules-tables';

export interface MappingEditorProps {
  view: CadMappingView;
  /** `cad_files:write` */
  canWrite: boolean;
  /** `design:write` */
  canBuild: boolean;
  saving: boolean;
  building: boolean;
  errorKey: MessageKey | null;
  offerReload: boolean;
  /** Resolves with the saved version, or null when the save failed. */
  onSave: (input: CadMappingInput) => Promise<number | null>;
  onBuild: (mappingVersion: number) => void;
  onReload: () => void;
}

/** The mapping form: CRS panel, rule tables, Save and Build revision. */
export function MappingEditor({
  view,
  canWrite,
  canBuild,
  saving,
  building,
  errorKey,
  offerReload,
  onSave,
  onBuild,
  onReload,
}: MappingEditorProps) {
  const { t } = useI18n();
  const form = useMappingForm(view);
  const processed = view.fileStatus === 'processed';
  const editable = canWrite && processed;

  const save = async () => {
    const prepared = form.prepareSave();
    if (!prepared) return;
    const version = await onSave(prepared.input);
    if (version !== null) form.markSaved(version, prepared.signature);
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && form.canSave && !saving) void save();
      }}
    >
      {!processed ? <Notice kind="info">{t('mapping.notProcessed')}</Notice> : null}
      {!canWrite ? <Notice kind="info">{t('mapping.readOnly')}</Notice> : null}

      <CrsPanel
        detection={view.crsDetection}
        projectEpsg={view.projectEpsg}
        insUnits={view.insUnits}
        epsg={form.state.epsg}
        epsgError={form.epsgError}
        unit={form.state.unit}
        warnings={form.warnings}
        disabled={!editable}
        onEpsgChange={form.setEpsg}
        onUnitChange={form.setUnit}
      />
      <LayerRulesTable
        view={view}
        state={form.state}
        disabled={!editable}
        onChange={form.setLayerTarget}
      />
      <BlockRulesTable
        view={view}
        state={form.state}
        disabled={!editable}
        onChange={form.setBlockChoice}
      />
      <TextRulesTable
        rows={form.textRows}
        state={form.state}
        disabled={!editable}
        truncated={view.texts.length >= MAPPING_TEXT_ROWS_LIMIT}
        onChange={form.setTextChoice}
      />

      {errorKey ? (
        <Notice kind="error">
          <p>{t(errorKey)}</p>
          {offerReload ? (
            <Button variant="outline" className="mt-2" onClick={onReload}>
              {t('mapping.error.reload')}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {form.justSavedVersion !== null ? (
        <Notice kind="success">{t('mapping.saved', { version: form.justSavedVersion })}</Notice>
      ) : null}

      {canWrite || canBuild ? (
        <div className="flex flex-wrap items-center gap-3">
          {canWrite ? (
            <Button type="submit" disabled={!editable || !form.canSave || saving}>
              {saving ? t('mapping.saving') : t('mapping.save')}
            </Button>
          ) : null}
          {canBuild ? (
            <Button
              variant="outline"
              disabled={!processed || !form.canBuild || building || saving}
              onClick={() => {
                if (form.savedVersion !== null) onBuild(form.savedVersion);
              }}
            >
              {building ? t('mapping.building') : t('mapping.build')}
            </Button>
          ) : null}
          {canWrite && !form.unitChosen ? (
            <span className="text-sm">{t('mapping.crs.unitRequired')}</span>
          ) : null}
          {canBuild && form.savedVersion === null ? (
            <span className="text-sm">{t('mapping.noSavedMapping')}</span>
          ) : canBuild && !form.canBuild ? (
            <span className="text-sm">{t('mapping.unsaved')}</span>
          ) : null}
        </div>
      ) : null}
      {form.savedVersion !== null ? (
        <p className="text-sm opacity-80">
          {t('mapping.savedVersion')}: <bdi dir="ltr">{form.savedVersion}</bdi>
        </p>
      ) : null}
    </form>
  );
}
