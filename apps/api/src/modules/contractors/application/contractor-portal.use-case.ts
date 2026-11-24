import type { ContractorPortalResponse, PortalTotals } from '@ftth/shared';
import type { Clock } from '../../../common/clock.js';
import { toDecimalText } from '../../../common/decimal-text.js';
import type {
  ContractorAccountContext,
  ContractorPortalRepository,
  PortalValueTotal,
} from '../domain/contractor-account.js';

/**
 * Totals per currency of his registrations, one entry each; a status without work is '0'.
 * Sums come from SQL numeric (exact); no float anywhere.
 */
export function buildTotals(
  currencies: readonly string[],
  sums: readonly PortalValueTotal[],
): PortalTotals[] {
  const sumOf = (currency: string, status: PortalValueTotal['status']): string => {
    const row = sums.find((sum) => sum.currency === currency && sum.status === status);
    return row ? toDecimalText(row.total) : '0';
  };
  return [...new Set(currencies)].map((currency) => ({
    currency,
    approved: sumOf(currency, 'approved'),
    pending: sumOf(currency, 'pending'),
    rejected: sumOf(currency, 'rejected'),
  }));
}

/** The contractor's own read-only view (ADR-053). Everything comes from the account's contractor id. */
export class GetContractorPortalUseCase {
  constructor(
    private readonly portal: ContractorPortalRepository,
    private readonly clock: Clock,
  ) {}

  async execute(account: ContractorAccountContext): Promise<ContractorPortalResponse> {
    const [registrations, work, sums] = await Promise.all([
      this.portal.registrations(account.contractorId),
      this.portal.work(account.contractorId),
      this.portal.valueTotals(account.contractorId),
    ]);
    return {
      serverTime: this.clock.now().toISOString(),
      contractor: { id: account.contractorId, name: account.contractorName },
      registrations,
      work,
      totals: buildTotals(
        registrations.map((registration) => registration.currency),
        sums,
      ),
    };
  }
}
