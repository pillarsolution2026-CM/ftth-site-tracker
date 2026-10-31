'use client';

import type { Dispatch } from 'react';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Input } from '@/shared/ui/input';
import { Checkbox, Textarea } from '@/shared/ui/form-controls';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { contractErrorKey } from '@/features/contracts/model/contract-forms';
import { CreateBlocked } from '@/features/work-orders/components/create-work-order';
import { workOrderConflictOf } from '@/features/work-orders/model/conflict';
import { WorkOrderErrorNotice } from '@/features/work-orders/components/work-order-error';
import { useWorkOrderGate } from '@/features/work-orders/hooks/use-work-order-gate';
import { useImportWizard } from '../hooks/use-import-wizard';
import type { CommitBlocker, WizardAction, WizardState } from '../model/import-wizard';
import { DuplicateDecisions } from './duplicate-decisions';
import { ImportInvalidNotice } from './import-invalid-notice';
import { ImportRowsTable } from './import-rows-table';
import { ImportSummary } from './import-summary';
import { MappingEditor } from './mapping-editor';

type Wizard = ReturnType<typeof useImportWizard>;

function UploadStep({
  reading,
  progress,
  fileName,
  errorCode,
  onFileChange,
}: Pick<Wizard, 'reading' | 'progress' | 'onFileChange'> & {
  fileName: string | null;
  errorCode: ClientErrorCode | null;
}) {
  const { t } = useI18n();
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('import.upload.title')}</h2>
      <p>{t('import.upload.explain')}</p>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      <label htmlFor="import-file" className="text-sm font-medium">
        {t('import.upload.choose')}
      </label>
      <input
        id="import-file"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        disabled={reading}
        onChange={onFileChange}
        className="min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
      />
      {reading ? (
        <p role="status">
          {t('import.upload.reading', { name: fileName ?? '' })}
          {progress !== null ? <progress value={progress} max={1} className="ms-2" /> : null}
        </p>
      ) : null}
    </Card>
  );
}

function HeaderSection({
  header,
  dispatch,
}: {
  header: WizardState['header'];
  dispatch: Dispatch<WizardAction>;
}) {
  const { t } = useI18n();
  const set = (field: keyof WizardState['header']) => (event: { target: { value: string } }) =>
    dispatch({ type: 'setHeaderField', field, value: event.target.value });
  return (
    <section aria-labelledby="import-header-title" className="flex flex-col gap-4">
      <h2 id="import-header-title" className="text-lg font-semibold">
        {t('import.header.title')}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="import-number"
          dir="ltr"
          required
          aria-required="true"
          label={t('workOrders.number')}
          value={header.number}
          onChange={set('number')}
        />
        <Input
          id="import-issuedOn"
          type="date"
          dir="ltr"
          label={t('workOrders.issuedOn')}
          value={header.issuedOn}
          onChange={set('issuedOn')}
        />
      </div>
      <Input
        id="import-title"
        label={t('workOrders.title')}
        value={header.title}
        onChange={set('title')}
      />
      <Textarea
        id="import-notes"
        label={t('workOrders.notes')}
        rows={2}
        value={header.notes}
        onChange={set('notes')}
      />
    </section>
  );
}

function Blockers({ blockers }: { blockers: CommitBlocker[] }) {
  const { t } = useI18n();
  if (blockers.length === 0) return null;
  return (
    <Notice kind="warning" live={false}>
      <p className="font-semibold">{t('import.blockers.title')}</p>
      <ul className="list-disc ps-5">
        {blockers.map((blocker) => (
          <li key={blocker}>{t(`import.blockers.${blocker}`)}</li>
        ))}
      </ul>
    </Notice>
  );
}

/** Contract import: no work-order header; the admin must confirm that the BOQ is replaced. */
export interface ContractReplace {
  existingLines: number;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
}

function ReplaceSection({ replace }: { replace: ContractReplace }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="import-replace-title" className="flex flex-col gap-3">
      <h2 id="import-replace-title" className="text-lg font-semibold">
        {t('admin.contracts.import.button')}
      </h2>
      <Notice kind="warning">{t('admin.contracts.import.replaceWarning')}</Notice>
      <Checkbox
        id="import-confirm-replace"
        label={t('admin.contracts.import.confirmReplace', { count: replace.existingLines })}
        checked={replace.confirmed}
        onChange={(event) => replace.onConfirm(event.target.checked)}
      />
    </section>
  );
}

export function ImportWizardView({
  wizard,
  contractReplace,
}: {
  wizard: Wizard;
  /** Present only for the contract BOQ import. */
  contractReplace?: ContractReplace;
}) {
  const { t } = useI18n();
  const { state, dispatch, selection } = wizard;
  const { preview, draft } = state;
  const forContract = contractReplace !== undefined;
  const needsConfirm = forContract && !contractReplace.confirmed;

  return (
    <div className="flex max-w-6xl flex-col gap-8">
      <h1 className="text-xl font-semibold">
        {forContract ? t('admin.contracts.import.title') : t('import.title')}
      </h1>
      <UploadStep
        reading={wizard.reading}
        progress={wizard.progress}
        fileName={wizard.file?.name ?? null}
        errorCode={wizard.previewErrorCode}
        onFileChange={wizard.onFileChange}
      />
      {preview && draft ? (
        <>
          <MappingEditor
            preview={preview}
            draft={draft}
            draftApplied={wizard.draftApplied}
            reading={wizard.reading}
            onSheet={(sheetName) => dispatch({ type: 'setSheet', sheetName })}
            onHeaderRow={(headerRow) => dispatch({ type: 'setHeaderRow', headerRow })}
            onMapping={(field, column) => dispatch({ type: 'setMapping', field, column })}
            onReread={wizard.rereadWithDraft}
          />
          <ImportSummary selection={selection} />
          {forContract ? (
            <DuplicateDecisions
              duplicates={preview.summary.duplicateCodes}
              decisions={state.decisions}
              unresolved={selection.unresolvedDuplicates}
              onDecide={(code, decision) => dispatch({ type: 'decide', code, decision })}
            />
          ) : null}
          <ImportRowsTable
            rows={preview.rows}
            excluded={selection.excluded}
            excludeErrorRows={state.excludeErrorRows}
            onToggleRow={(rowNumber) => dispatch({ type: 'toggleRow', rowNumber })}
            onExcludeErrorRows={(value) => dispatch({ type: 'setExcludeErrorRows', value })}
          />
          {contractReplace ? (
            <ReplaceSection replace={contractReplace} />
          ) : (
            <HeaderSection header={state.header} dispatch={dispatch} />
          )}
          {wizard.invalidDetails || wizard.commitErrorCode === 'IMPORT_INVALID' ? (
            <ImportInvalidNotice details={wizard.invalidDetails} />
          ) : wizard.commitErrorCode ? (
            forContract ? (
              <Notice kind="error">{t(contractErrorKey(wizard.commitError))}</Notice>
            ) : workOrderConflictOf(wizard.commitError) ? (
              <WorkOrderErrorNotice error={wizard.commitError} />
            ) : wizard.commitErrorCode === 'CONFLICT' ? (
              <Notice kind="error">{t('workOrders.numberTaken')}</Notice>
            ) : (
              <ErrorNotice code={wizard.commitErrorCode} />
            )
          ) : null}
          <Blockers blockers={wizard.blockers} />
          {needsConfirm ? (
            <Notice kind="info" live={false}>
              {t('admin.contracts.import.needConfirm')}
            </Notice>
          ) : null}
          <div>
            <Button
              onClick={wizard.submit}
              disabled={wizard.blockers.length > 0 || wizard.committing || needsConfirm}
            >
              {wizard.committing
                ? forContract
                  ? t('admin.contracts.import.committing')
                  : t('import.committing')
                : forContract
                  ? t('admin.contracts.import.commit')
                  : t('import.commit')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ImportWizardGated({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const gate = useWorkOrderGate(projectId);
  const wizard = useImportWizard({ kind: 'workOrder', projectId });
  if (gate.status === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (gate.status === 'error') return <ErrorNotice code={gate.errorCode} />;
  // No work order can be created (no contract, draft contract, or the one work order exists):
  // say so before the user uploads a file.
  if (gate.status === 'blocked') {
    return (
      <CreateBlocked
        reason={gate.reason}
        existingPath={
          gate.workOrder
            ? `/${locale}/projects/${projectId}/work-orders/${gate.workOrder.id}`
            : undefined
        }
        existingNumber={gate.workOrder?.number}
      />
    );
  }
  return <ImportWizardView wizard={wizard} />;
}

export function ImportWizard({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { can } = useProject();
  if (!can('work_orders:write')) return <Notice kind="error">{t('errors.FORBIDDEN')}</Notice>;
  return <ImportWizardGated projectId={projectId} />;
}
