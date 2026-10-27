'use client';

import { useMemo, useReducer, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImportInvalidDetailsSchema, type WorkOrderImportPreviewOptions } from '@ftth/shared';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { workOrdersKey } from '@/features/work-orders/api/queries';
import { commitImport, previewImport } from '../api/import-api';
import {
  INITIAL_WIZARD_STATE,
  buildCommitPayload,
  commitBlockers,
  deriveSelection,
  isDraftApplied,
  previewOptionsFromDraft,
  wizardReducer,
} from '../model/import-wizard';

/** Upload → preview → decisions → commit. All rules live in the pure model. */
export function useImportWizard(projectId: string) {
  const { locale } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const preview = useMutation({
    mutationFn: (input: { file: File; options: WorkOrderImportPreviewOptions }) =>
      previewImport(projectId, input.file, input.options, { onProgress: setProgress }),
    onSuccess: (result) => dispatch({ type: 'previewLoaded', preview: result }),
    onSettled: () => setProgress(null),
  });

  const commit = useMutation({
    mutationFn: (input: {
      file: File;
      payload: NonNullable<ReturnType<typeof buildCommitPayload>>;
    }) => commitImport(projectId, input.file, input.payload, { onProgress: setProgress }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: workOrdersKey(projectId) });
      router.push(`/${locale}/projects/${projectId}/work-orders/${created.id}`);
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
    const payload = buildCommitPayload(state);
    if (file && payload) commit.mutate({ file, payload });
  };

  const selection = useMemo(() => deriveSelection(state), [state]);
  const blockers = useMemo(() => commitBlockers(state), [state]);

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
    invalidDetails: invalid?.success ? invalid.data : null,
  };
}
