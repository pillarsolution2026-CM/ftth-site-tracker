'use client';

import { useEffect, useMemo } from 'react';
import {
  MAPPING_TEXT_ROWS_LIMIT,
  type CadMappingInput,
  type CadMappingView,
  type DrawingKind,
  type PlacementDrawing,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { GeneralCabinetsState } from '../hooks/use-general-cabinets';
import { useMappingForm } from '../hooks/use-mapping-form';
import { placementPreview } from '../model/placement-preview';
import { CrsPanel } from './crs-panel';
import { PlacementMap } from './placement-map';
import { PlacementPanel } from './placement-panel';
import { BlockRulesTable, LayerRulesTable, TextRulesTable } from './rules-tables';

export interface MappingEditorProps {
  view: CadMappingView;
  /** The file's drawing kind (General / Secondary): decides the text roles and the zone target. */
  drawingKind?: DrawingKind | null;
  /** Items and route lines in drawing units for placing the drawing (ADR-035); null while loading. */
  drawing: PlacementDrawing | null;
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
  /** «من كبائن الرئيسي» of a Secondary (ADR-042 part G); omitted for a General. */
  cabinets?: GeneralCabinetsState | null;
}

/** The mapping form: CRS panel, placement, rule tables, Save and Build revision. */
export function MappingEditor({
  view,
  drawing,
  canWrite,
  canBuild,
  saving,
  building,
  errorKey,
  offerReload,
  onSave,
  onBuild,
  onReload,
  drawingKind = null,
  cabinets = null,
}: MappingEditorProps) {
  const { t } = useI18n();
  const form = useMappingForm(view, drawingKind);
  const processed = view.fileStatus === 'processed';
  const editable = canWrite && processed;
  const preview = useMemo(
    () =>
      form.solved.ok
        ? placementPreview(
            drawing,
            form.state.placement.points,
            form.solved.solution,
            form.projectEpsg,
          )
        : null,
    [drawing, form.state.placement.points, form.solved, form.projectEpsg],
  );

  // The suggested points go into the form once; the PM saves as usual.
  const pending = cabinets?.pending ?? null;
  const consume = cabinets?.consume;
  const applyGeneralCabinets = form.applyGeneralCabinets;
  useEffect(() => {
    if (!pending || !consume) return;
    const dropped = applyGeneralCabinets(pending.points);
    consume({ added: Math.max(0, pending.points.length - dropped), dropped });
  }, [pending, consume, applyGeneralCabinets]);

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
        disabled={!editable}
        onEpsgChange={form.setEpsg}
      />
      {processed ? (
        <PlacementPanel
          drawing={drawing}
          state={form.state.placement}
          solved={form.solved}
          suggestedRedBelt={view.crsDetection?.suggestedSourceCrs === 'egypt_red_belt'}
          disabled={!editable}
          onSourceCrsChange={form.setSourceCrs}
          onAddPoints={form.addPoints}
          onUpdatePoint={form.updatePoint}
          onRemovePoint={form.removePoint}
          onFitScaleChange={form.setFitScaleWithTwoPoints}
          cabinets={cabinets}
        />
      ) : null}
      {processed && preview ? (
        <PlacementMap
          preview={preview}
          projectEpsg={form.projectEpsg}
          adjust={form.state.placement.adjust}
          truncatedAt={drawing?.truncated ? drawing.lines.length : null}
          disabled={!editable}
          onAdjust={form.setAdjust}
          onReset={form.resetAdjust}
        />
      ) : null}
      <LayerRulesTable
        view={view}
        state={form.state}
        kind={drawingKind}
        disabled={!editable}
        onChange={form.setLayerTarget}
        onAttrsChange={form.setRuleAttrs}
        onRolesChange={form.setLayerRoles}
        onWaysChange={form.setLayerWays}
        onAliasRemove={form.removeLayerAlias}
        onSuggestMeaning={form.suggestMeaning}
      />
      <BlockRulesTable
        view={view}
        state={form.state}
        disabled={!editable}
        onChange={form.setBlockChoice}
        onAttrsChange={form.setRuleAttrs}
      />
      <TextRulesTable
        rows={form.textRows}
        state={form.state}
        disabled={!editable}
        truncated={view.texts.length >= MAPPING_TEXT_ROWS_LIMIT}
        onChange={form.setTextChoice}
        onAttrsChange={form.setRuleAttrs}
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
          {canWrite && form.missingRoles.length > 0 ? (
            <span className="text-sm" role="status">
              {t('mapping.role.required', { names: form.missingRoles.join(', ') })}
            </span>
          ) : null}
          {canWrite && form.badWays.length > 0 ? (
            <span className="text-sm" role="status">
              {t('mapping.meaning.waysRequired', { names: form.badWays.join(', ') })}
            </span>
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
