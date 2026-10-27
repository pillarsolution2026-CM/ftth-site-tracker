'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Permission } from '@ftth/shared';
import { can, type ProjectAccess } from '../model/project-access';

interface ProjectContextValue {
  projectId: string;
  access: ProjectAccess;
  can: (permission: Permission) => boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectAccessProvider({
  projectId,
  access,
  children,
}: {
  projectId: string;
  access: ProjectAccess;
  children: ReactNode;
}) {
  const value = useMemo<ProjectContextValue>(
    () => ({ projectId, access, can: (permission) => can(access, permission) }),
    [projectId, access],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProject must be used inside <ProjectAccessProvider>');
  return value;
}
