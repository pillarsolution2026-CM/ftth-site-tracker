import type {
  Contractor,
  ContractorLine as LineDto,
  ContractorImportFile as FileDto,
  ContractorLineAvailability,
  ContractorPrice as PriceDto,
  ContractorRegistration,
  ProjectContractorsResponse,
} from '@ftth/shared';
import type { ProjectContractorsView } from '../application/contractor-queries.js';
import type {
  ContractorImportFile,
  ContractorLine,
  ContractorPrice,
  ContractorSummary,
  Registration,
} from '../domain/contractor.js';

export const toContractorDto = (contractor: ContractorSummary): Contractor => ({
  id: contractor.id,
  name: contractor.name,
  contactName: contractor.contactName,
  contactPhone: contractor.contactPhone,
  commercialRegister: contractor.commercialRegister,
  taxCard: contractor.taxCard,
  workOrderCount: contractor.workOrderCount,
  version: contractor.version,
  createdAt: contractor.createdAt.toISOString(),
  updatedAt: contractor.updatedAt.toISOString(),
});

const toPriceDto = (price: ContractorPrice): PriceDto => ({
  id: price.id,
  effectiveFrom: price.effectiveFrom,
  unitPrice: price.unitPrice.toString(),
  createdById: price.createdById,
  createdAt: price.createdAt.toISOString(),
});

const toFileDto = (file: ContractorImportFile): FileDto => ({
  id: file.id,
  fileName: file.fileName,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  uploadedById: file.uploadedById,
  createdAt: file.createdAt.toISOString(),
});

const toLineDto = (line: ContractorLine): LineDto => ({
  id: line.id,
  workOrderItemId: line.item.id,
  lineNo: line.item.lineNo,
  code: line.item.code,
  description: line.item.description,
  unit: line.item.unit,
  workType: line.item.workType,
  scope: line.scope,
  contractPrice: line.item.unitPrice.toString(),
  quantity: line.quantity.toString(),
  prices: line.prices.map(toPriceDto),
  sourceRow: line.sourceRow,
});

const toRegistrationDto = (registration: Registration): ContractorRegistration => ({
  id: registration.id,
  projectId: registration.projectId,
  workOrderId: registration.workOrderId,
  contractor: registration.contractor,
  registeredOn: registration.registeredOn,
  lines: registration.lines.map(toLineDto),
  files: registration.files.map(toFileDto),
  createdById: registration.createdById,
  createdAt: registration.createdAt.toISOString(),
});

export const toProjectContractorsDto = (
  view: ProjectContractorsView,
): ProjectContractorsResponse => ({
  projectId: view.projectId,
  workOrderId: view.workOrderId,
  currency: view.currency,
  registrations: view.registrations.map(toRegistrationDto),
  availability: view.availability.map(
    ({ item, mode, scopes, scopesPriceTotal, priceRoom }): ContractorLineAvailability => ({
      workOrderItemId: item.id,
      lineNo: item.lineNo,
      code: item.code,
      description: item.description,
      unit: item.unit,
      workType: item.workType,
      contractPrice: item.unitPrice.toString(),
      workOrderQuantity: item.quantity.toString(),
      mode,
      scopes: scopes.map((scope) => ({
        scope: scope.scope,
        reservedQuantity: scope.reserved.toString(),
        availableQuantity: scope.available.toString(),
        highestPrice: scope.highestPrice.toString(),
      })),
      scopesPriceTotal: scopesPriceTotal.toString(),
      priceRoom: priceRoom.toString(),
      assignable: item.contractItemId !== null,
    }),
  ),
});
