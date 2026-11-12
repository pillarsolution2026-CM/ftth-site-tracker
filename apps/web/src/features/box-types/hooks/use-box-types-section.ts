'use client';

import { useMemo, useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import type { ErrorMessage } from '@/features/design-revisions/model/revision-errors';
import {
  useBoxTypeState,
  useBoxTypesReport,
  useSetBoxTypes,
  useWorkOrderLines,
} from '../api/queries';
import {
  activeByShape,
  boxTypeErrorKey,
  dirtyChoices,
  previousChoices,
} from '../model/box-types-model';

/**
 * State of the «أنواع البوكسات» section (ADR-043): the gallery of the revision, the live choices
 * of the Secondary file, the lines of the work order, and what the PM picked but did not save.
 * Saving sends only the shapes that changed, in one batch.
 */
export function useBoxTypesSection(input: {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  enabled: boolean;
  /** Draft revision and `design:write`. */
  canEdit: boolean;
}) {
  const { projectId, revisionId, cadFileId, enabled, canEdit } = input;
  const { can } = useProject();
  const report = useBoxTypesReport(projectId, revisionId, enabled);
  const applies = report.data?.applies === true;
  const state = useBoxTypeState(projectId, cadFileId, enabled && applies && can('cad_files:read'));
  const workOrder = useWorkOrderLines(projectId, enabled && applies && can('work_orders:read'));
  const save = useSetBoxTypes(projectId, cadFileId, revisionId);
  const [draft, setDraft] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<ErrorMessage | null>(null);

  const gallery = report.data?.gallery ?? null;
  const shapes = useMemo(() => gallery?.shapes ?? [], [gallery]);
  const active = useMemo(() => activeByShape(state.data), [state.data]);
  const dirty = useMemo(() => dirtyChoices(shapes, active, draft), [shapes, active, draft]);
  const previous = useMemo(
    () => previousChoices(state.data, gallery, active),
    [state.data, gallery, active],
  );
  const lineIds = useMemo(() => new Set(workOrder.lines.map((line) => line.id)), [workOrder.lines]);

  function run(choices: ReturnType<typeof dirtyChoices>, fromPreviousVersion: boolean) {
    if (!canEdit || save.isPending || choices.length === 0) return;
    setError(null);
    save.mutate(
      { choices, fromPreviousVersion },
      {
        onSuccess: () => setDraft(new Map()),
        onError: (caught) =>
          setError({
            key: boxTypeErrorKey(errorCodeOf(caught), errorReasonOf(caught)),
            params: {},
          }),
      },
    );
  }

  return {
    loading: report.isLoading,
    loadErrorCode: report.error ? errorCodeOf(report.error) : null,
    /** The section is for a Secondary read by roles; false hides it. */
    applies,
    report: report.data ?? null,
    shapes,
    boxCount: gallery?.boxCount ?? 0,
    shapeCount: gallery?.shapeCount ?? 0,
    stateFailed: state.isError,
    workOrder,
    lineIds,
    canEdit,
    saving: save.isPending,
    error,
    /** The line shown in the picker of a shape: the unsaved pick, else the one in force, else none. */
    valueOf: (shape: string) => draft.get(shape) ?? active.get(shape) ?? '',
    isSaved: (shape: string) => active.has(shape),
    pick: (shape: string, lineId: string) =>
      setDraft((previousDraft) => new Map(previousDraft).set(shape, lineId)),
    dirtyCount: dirty.length,
    save: () => run(dirty, false),
    previousCount: previous.length,
    usePrevious: () => run(previous, true),
    /** The live choices differ from the draft: rebuild to apply them. */
    rebuildNeeded: report.data?.changedSinceBuild === true,
  };
}

export type BoxTypesSectionState = ReturnType<typeof useBoxTypesSection>;
