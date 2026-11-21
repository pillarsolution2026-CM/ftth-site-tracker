import { useAuth } from '../../auth/hooks/AuthProvider';
import { ProjectsScreen } from '../../projects/components/ProjectsScreen';
import type { PortalCache } from '../model/portal-cache';
import { ContractorScreen, type PortalSource } from './ContractorScreen';

/**
 * Home after sign-in. A contractor account (`/me.contractor`, ADR-053) gets only the read-only
 * contractor screen: no projects, drawings, update flow or sync. Everyone else is unchanged.
 */
export function HomeSwitch({
  onOpenProject,
  portalApi,
  portalCache,
}: {
  onOpenProject: (projectId: string) => void;
  portalApi: PortalSource;
  portalCache: PortalCache;
}) {
  const { me } = useAuth();
  if (me?.contractor) return <ContractorScreen api={portalApi} cache={portalCache} />;
  return <ProjectsScreen onOpen={onOpenProject} />;
}
