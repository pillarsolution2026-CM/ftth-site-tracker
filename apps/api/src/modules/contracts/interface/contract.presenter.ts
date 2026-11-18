import {
  parentCodeOf,
  type ItemGroupState,
  type ContractAttachment as AttachmentDto,
  type ContractDetail,
  type ContractItem as ItemDto,
  type ContractSummary,
} from '@ftth/shared';
import { itemGroupStates } from '../../../common/item-groups.js';
import type { ContractView } from '../application/contract-queries.js';
import { lineAmount, type ContractLine } from '../domain/contract.js';
import type { ContractAttachment, ContractSummaryRow } from '../domain/contract.repository.js';

export function toItemDto(
  line: ContractLine,
  contractId: string,
  codes: ReadonlySet<string>,
  group: ItemGroupState | null,
): ItemDto {
  return {
    id: line.id,
    contractId,
    lineNo: line.lineNo,
    kind: line.kind,
    code: line.code,
    description: line.description,
    parentCode: parentCodeOf(line.code, codes),
    unit: line.unit,
    quantity: line.quantity?.toString() ?? null,
    unitPrice: line.unitPrice?.toString() ?? null,
    amount: lineAmount(line)?.toString() ?? null,
    workType: line.workType,
    source: line.source,
    sourceRow: line.sourceRow,
    group,
  };
}

export function toAttachmentDto(attachment: ContractAttachment): AttachmentDto {
  return {
    id: attachment.id,
    contractId: attachment.contractId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    uploadedById: attachment.uploadedById,
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function toSummaryDto(summary: ContractSummaryRow): ContractSummary {
  const { header } = summary;
  return {
    id: header.id,
    number: header.number,
    name: header.name,
    client: header.client,
    currency: header.currency,
    startsOn: header.startsOn,
    durationDays: header.durationDays,
    status: header.status,
    approvedAt: header.approvedAt?.toISOString() ?? null,
    itemCount: summary.itemCount,
    total: summary.total.toString(),
    projectCount: summary.projectCount,
    version: header.version,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
  };
}

export function toDetailDto({
  contract,
  attachments,
  projectCount,
  manualGroups,
}: ContractView): ContractDetail {
  const { header } = contract;
  const codes = new Set(contract.lines.map((line) => line.code));
  const states = itemGroupStates(contract.lines, manualGroups);
  return {
    ...toSummaryDto({
      header,
      itemCount: contract.items.length,
      total: contract.total,
      projectCount,
    }),
    notes: header.notes,
    approvedById: header.approvedById,
    items: contract.lines.map((line) =>
      toItemDto(line, header.id, codes, states.get(line.id) ?? null),
    ),
    attachments: attachments.map(toAttachmentDto),
    duplicateCodes: contract.duplicateCodes(),
    ungroupedItemCount: [...states.values()].filter((state) => state.source === 'none').length,
  };
}
