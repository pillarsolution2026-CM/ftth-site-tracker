import { DEFAULT_GPS_WARNING_DISTANCE_M } from '@ftth/shared';
import type { ExecutionCapabilities } from './ports.js';

/**
 * Capabilities while Phase 2 (`type_rules`, BOQ matching) does not exist (ADR-023): no suggested
 * quantity and no per-activity photo requirements. The single generic photo follows the plan's
 * principle that every recorded quantity comes with its photos — the owner may change it.
 */
export class Phase2UnavailableCapabilities implements ExecutionCapabilities {
  suggestedQuantity(): 'unavailable' {
    return 'unavailable';
  }

  photoRequirements() {
    return {
      status: 'unavailable' as const,
      byWorkType: {},
      fallback: [{ key: 'general', minCount: 1 }],
    };
  }

  gpsWarningDistanceM(): number {
    return DEFAULT_GPS_WARNING_DISTANCE_M;
  }
}
