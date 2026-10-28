'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CadMappingInput } from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useCreateDesignRevision } from '@/features/design-revisions/api/queries';
import { useMapping, useSaveMapping } from '../api/queries';
import { mappingErrorKey, needsReload } from '../model/mapping-errors';

/** Server state and actions of the mapping screen: view, save (PUT) and build revision (POST). */
export function useMappingScreen(projectId: string, cadFileId: string) {
  const { locale } = useI18n();
  const router = useRouter();
  const { can } = useProject();
  const canRead = can('cad_files:read');
  const view = useMapping(projectId, cadFileId, canRead);
  const save = useSaveMapping(projectId, cadFileId);
  const create = useCreateDesignRevision(projectId);
  // Bumped on reload so the editor starts again from the freshly read mapping.
  const [reloadCount, setReloadCount] = useState(0);

  const error = save.error ?? create.error;
  const code = error ? errorCodeOf(error) : null;
  const reason = error ? errorReasonOf(error) : null;

  return {
    canRead,
    canWrite: can('cad_files:write'),
    canBuild: can('design:write'),
    view: view.data ?? null,
    loadErrorCode: view.error ? errorCodeOf(view.error) : null,
    reloadCount,
    saving: save.isPending,
    building: create.isPending,
    errorKey: code ? mappingErrorKey(code, reason) : null,
    offerReload: code ? needsReload(code, reason) : false,
    /** Resolves with the saved version, or null when the save failed (the error is shown). */
    save: async (input: CadMappingInput): Promise<number | null> => {
      create.reset();
      try {
        return (await save.mutateAsync(input)).version;
      } catch {
        return null;
      }
    },
    /** Queues the build with the saved version and opens the new revision. */
    build: async (mappingVersion: number): Promise<void> => {
      save.reset();
      try {
        const revision = await create.mutateAsync({ cadFileId, mappingVersion });
        router.push(`/${locale}/projects/${projectId}/design-revisions/${revision.id}`);
      } catch {
        // shown through errorKey
      }
    },
    reload: async () => {
      save.reset();
      create.reset();
      await view.refetch();
      setReloadCount((count) => count + 1);
    },
  };
}
