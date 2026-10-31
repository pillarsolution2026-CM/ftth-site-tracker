'use client';

import { useMemo, useReducer, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ImportInvalidDetailsSchema,
  type ContractDetail,
  type WorkOrderDetail,
  type WorkOrderImportPreviewOptions,
} from '@ftth/shared';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { workOrdersKey } from '@/features/work-orders/api/queries';
import { contractKey, contractsKey } from '@/features/contracts/api/queries';
import {
  commitContractImport,
  commitImport,
  previewContractImport,
  previewImport,
} from '../api/import-api';
import {
  INITIAL_WIZARD_STATE,
  buildCommitPayload,
  buildContractCommitPayload,
  commitBlockers,
  deriveSelection,
  isDraftApplied,
  previewOptionsFromDraft,
  wizardReducer,
} from '../model/import-wizard';

/**
 * What the wizard imports into: a new work order of a project, or every line of a draft contract
 * (ADR-027; replaces the BOQ, no work-order header).
 */
export type ImportTarget =
  | { kind: 'workOrder'; projectId: string }
  | { kind: 'contract'; contractId: string; expectedVersion: number };

type CommitPayload =
  | { kind: 'workOrder'; body: NonNullable<ReturnType<typeof buildCommitPayload>> }
  | { kind: 'contract'; body: NonNullable<ReturnType<typeof buildContractCommitPayload>> };

/** Upload → preview → decisions → commit. All rules live in the pure model. */
export function useImportWizard(target: ImportTarget) {
  const { locale } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const preview = useMutation({
    mutationFn: (input: { file: File; options: WorkOrderImportPreviewOptions }) =>
      target.kind === 'workOrder'
        ? previewImport(target.projectId, input.file, input.options, { onProgress: setProgress })
        : previewContractImport(target.contractId, input.file, input.options, {
            onProgress: setProgress,
          }),
    onSuccess: (result) => dispatch({ type: 'previewLoaded', preview: result }),
    onSettled: () => setProgress(null),
  });

  const commit = useMutation({
    mutationFn: (input: {
      file: File;
      payload: CommitPayload;
    }): Promise<ContractDetail | WorkOrderDetail> =>
      input.payload.kind === 'workOrder' && target.kind === 'workOrder'
        ? commitImport(target.projectId, input.file, input.payload.body, {
            onProgress: setProgress,
          })
        : input.payload.kind === 'contract' && target.kind === 'contract'
          ? commitContractImport(target.contractId, input.file, input.payload.body, {
              onProgress: setProgress,
            })
          : Promise.reject(new Error('import target mismatch')),
    onSuccess: async (created) => {
      if (target.kind === 'workOrder') {
        await client.invalidateQueries({ queryKey: workOrdersKey(target.projectId) });
        router.push(`/${locale}/projects/${target.projectId}/work-orders/${created.id}`);
        return;
      }
      client.setQueryData(contractKey(target.contractId), created);
      await client.invalidateQueries({ queryKey: contractsKey });
      router.push(`/${locale}/admin/contracts/${target.contractId}`);
    },
    onSettled: () => setProgress(null),
  });

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    commit.reset();
    dispatch({ type: 'reset' });
    setFile(selected);
    if (selected) preview.mutate({ file: selected, options: {} });
  };

  const rereadWithDraft = () => {
    if (file) preview.mutate({ file, options: previewOptionsFromDraft(state) });
  };

  const submit = () => {
    if (!file) return;
    if (target.kind === 'workOrder') {
      const body = buildCommitPayload(state);
      if (body) commit.mutate({ file, payload: { kind: 'workOrder', body } });
    } else {
      const body = buildContractCommitPayload(state, target.expectedVersion);
      if (body) commit.mutate({ file, payload: { kind: 'contract', body } });
    }
  };

  const selection = useMemo(() => deriveSelection(state), [state]);
  const targetKind = target.kind;
  const blockers = useMemo(
    () => commitBlockers(state, { target: targetKind }),
    [state, targetKind],
  );

  const invalid =
    commit.error instanceof ApiClientError && commit.error.code === 'IMPORT_INVALID'
      ? ImportInvalidDetailsSchema.safeParse(commit.error.details)
      : null;

  return {
    state,
    dispatch,
    file,
    progress,
    selection,
    blockers,
    draftApplied: isDraftApplied(state),
    onFileChange,
    rereadWithDraft,
    submit,
    reading: preview.isPending,
    committing: commit.isPending,
    previewErrorCode: preview.error ? errorCodeOf(preview.error) : null,
    commitErrorCode: commit.error ? errorCodeOf(commit.error) : null,
    commitError: commit.error,
    invalidDetails: invalid?.success ? invalid.data : null,
  };
}
