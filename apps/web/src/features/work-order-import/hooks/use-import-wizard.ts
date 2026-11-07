'use client';

import { useMemo, useReducer, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ImportInvalidDetailsSchema,
  type ContractDetail,
  type ContractorImportTarget,
  type ProjectContractorsResponse,
  type WorkOrderDetail,
  type WorkOrderImportPreviewOptions,
} from '@ftth/shared';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { contractItemsKey, workOrdersKey } from '@/features/work-orders/api/queries';
import { contractKey, contractsKey } from '@/features/contracts/api/queries';
import {
  adminProjectContractorsKey,
  contractorsKey,
  projectContractorsKey,
} from '@/features/contractors/api/queries';
import {
  commitContractImport,
  commitContractorImport,
  commitImport,
  previewContractImport,
  previewContractorImport,
  previewImport,
} from '../api/import-api';
import {
  INITIAL_WIZARD_STATE,
  buildCommitPayload,
  buildContractCommitPayload,
  buildContractorCommitPayload,
  commitBlockers,
  deriveSelection,
  isDraftApplied,
  previewOptionsFromDraft,
  wizardReducer,
} from '../model/import-wizard';

/**
 * What the wizard imports into: a new work order of a project, every line of a draft contract
 * (ADR-027; replaces the BOQ, no work-order header), or the lines of a subcontractor on the
 * project's work order (ADR-036; a new registration or lines appended to one).
 */
export type ImportTarget =
  | { kind: 'workOrder'; projectId: string }
  | { kind: 'contract'; contractId: string; expectedVersion: number }
  | { kind: 'contractor'; projectId: string; target: ContractorImportTarget };

type CommitPayload =
  | { kind: 'workOrder'; body: NonNullable<ReturnType<typeof buildCommitPayload>> }
  | { kind: 'contract'; body: NonNullable<ReturnType<typeof buildContractCommitPayload>> }
  | { kind: 'contractor'; body: NonNullable<ReturnType<typeof buildContractorCommitPayload>> };

/** Upload → preview → decisions → commit. All rules live in the pure model. */
export function useImportWizard(target: ImportTarget) {
  const { locale } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const preview = useMutation({
    mutationFn: (input: { file: File; options: WorkOrderImportPreviewOptions }) => {
      const upload = { onProgress: setProgress };
      if (target.kind === 'workOrder') {
        return previewImport(target.projectId, input.file, input.options, upload);
      }
      if (target.kind === 'contractor') {
        return previewContractorImport(
          target.projectId,
          input.file,
          { ...input.options, target: target.target },
          upload,
        );
      }
      return previewContractImport(target.contractId, input.file, input.options, upload);
    },
    onSuccess: (result) => dispatch({ type: 'previewLoaded', preview: result }),
    onSettled: () => setProgress(null),
  });

  const commit = useMutation({
    mutationFn: (input: {
      file: File;
      payload: CommitPayload;
    }): Promise<ContractDetail | WorkOrderDetail | ProjectContractorsResponse> => {
      const upload = { onProgress: setProgress };
      const { payload } = input;
      if (payload.kind === 'workOrder' && target.kind === 'workOrder') {
        return commitImport(target.projectId, input.file, payload.body, upload);
      }
      if (payload.kind === 'contract' && target.kind === 'contract') {
        return commitContractImport(target.contractId, input.file, payload.body, upload);
      }
      if (payload.kind === 'contractor' && target.kind === 'contractor') {
        return commitContractorImport(target.projectId, input.file, payload.body, upload);
      }
      return Promise.reject(new Error('import target mismatch'));
    },
    onSuccess: async (created) => {
      if (target.kind === 'workOrder') {
        if (!('id' in created)) return;
        await Promise.all([
          client.invalidateQueries({ queryKey: workOrdersKey(target.projectId) }),
          client.invalidateQueries({ queryKey: contractItemsKey(target.projectId) }),
        ]);
        router.push(`/${locale}/projects/${target.projectId}/work-orders/${created.id}`);
        return;
      }
      if (target.kind === 'contractor') {
        client.setQueryData(adminProjectContractorsKey(target.projectId), created);
        await Promise.all([
          client.invalidateQueries({ queryKey: adminProjectContractorsKey(target.projectId) }),
          client.invalidateQueries({ queryKey: projectContractorsKey(target.projectId) }),
          client.invalidateQueries({ queryKey: contractorsKey }),
        ]);
        router.push(`/${locale}/admin/projects/${target.projectId}`);
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
    if (file) {
      preview.mutate({
        file,
        options: previewOptionsFromDraft(state, target.kind === 'contractor'),
      });
    }
  };

  const submit = () => {
    if (!file) return;
    if (target.kind === 'workOrder') {
      const body = buildCommitPayload(state);
      if (body) commit.mutate({ file, payload: { kind: 'workOrder', body } });
    } else if (target.kind === 'contractor') {
      const body = buildContractorCommitPayload(state, target.target);
      if (body) commit.mutate({ file, payload: { kind: 'contractor', body } });
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
