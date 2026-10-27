import type { MessageKey } from '@ftth/i18n';
import type { CadFileStatus } from '@ftth/shared';

export const CAD_POLL_MS = 3000;

/** Waiting for or inside the worker: keep polling. */
export function isInFlight(status: CadFileStatus): boolean {
  return status === 'uploaded' || status === 'queued' || status === 'processing';
}

/** Status is always shown as icon + text; the colour class is only a reinforcement. */
export const STATUS_PRESENTATION: Record<
  CadFileStatus,
  { icon: string; labelKey: MessageKey; className: string }
> = {
  uploaded: {
    icon: '↑',
    labelKey: 'cad.status.uploaded',
    className: 'border-(--status-notStarted)',
  },
  queued: { icon: '…', labelKey: 'cad.status.queued', className: 'border-(--status-notStarted)' },
  processing: {
    icon: '⟳',
    labelKey: 'cad.status.processing',
    className: 'border-(--status-inProgress)',
  },
  processed: {
    icon: '✓',
    labelKey: 'cad.status.processed',
    className: 'border-(--status-approved)',
  },
  failed: { icon: '✕', labelKey: 'cad.status.failed', className: 'border-(--status-rejected)' },
};

const CAD_EXTENSIONS = ['.dwg', '.dxf'];

export function isCadFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return CAD_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
