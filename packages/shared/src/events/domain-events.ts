/**
 * `events.entity` / `events.type` values introduced in Phase 1a. Payloads carry money and
 * quantities as decimal strings and, for updates, `{ before, after }` of the changed fields only.
 */
export const EVENT_ENTITIES = {
  workOrder: 'work_order',
  workOrderItem: 'work_order_item',
  workOrderAttachment: 'work_order_attachment',
  cadFile: 'cad_file',
  cadMapping: 'cad_mapping',
  gpsProposal: 'gps_proposal',
  drawingCorrection: 'drawing_correction',
  /** ADR-042 part D: rows of `cad_file_installation_answers` / `cad_file_trench_marks`. */
  installationAnswer: 'installation_answer',
  trenchMark: 'trench_mark',
  /** ADR-043: rows of `cad_file_box_type_choices`. */
  boxTypeChoice: 'box_type_choice',
  designRevision: 'design_revision',
  textLink: 'text_link',
  executionUpdate: 'execution_update',
  executionPhoto: 'execution_photo',
  contract: 'contract',
  contractItem: 'contract_item',
  contractAttachment: 'contract_attachment',
  asBuiltEdit: 'asbuilt_edit',
  asBuiltExport: 'asbuilt_export',
  contractor: 'contractor',
  contractorRegistration: 'contractor_registration',
  contractorLine: 'contractor_line',
} as const;

export const EVENT_TYPES = {
  workOrderCreated: 'work_order.created',
  /** Created by an Excel import; payload includes file sha256, sheet, mapping, row counts. */
  workOrderImported: 'work_order.imported',
  workOrderUpdated: 'work_order.updated',
  /** Payload is a full snapshot of the header and items (the rows are hard-deleted). */
  workOrderDeleted: 'work_order.deleted',
  workOrderItemAdded: 'work_order_item.added',
  workOrderItemUpdated: 'work_order_item.updated',
  workOrderItemRemoved: 'work_order_item.removed',
  workOrderAttachmentAdded: 'work_order_attachment.added',
  workOrderAttachmentRemoved: 'work_order_attachment.removed',
  cadFileUploaded: 'cad_file.uploaded',
  cadFileQueued: 'cad_file.queued',
  /** Written by the worker (actor_id NULL). */
  cadFileProcessingStarted: 'cad_file.processing_started',
  cadFileProcessed: 'cad_file.processed',
  cadFileFailed: 'cad_file.failed',
  /** Written by the CAD worker (ADR-039), no actor. */
  cadFileViewRendered: 'cad_file.view_rendered',
  cadFileViewFailed: 'cad_file.view_failed',
  /** Payload: version, crsEpsg, drawingUnit, rule count. */
  cadMappingSaved: 'cad_mapping.saved',
  gpsProposalReceived: 'gps_proposal.received',
  gpsProposalAccepted: 'gps_proposal.accepted',
  gpsProposalRejected: 'gps_proposal.rejected',
  drawingCorrectionAdded: 'drawing_correction.added',
  drawingCorrectionWithdrawn: 'drawing_correction.withdrawn',
  /** ADR-042. Payload: { cadFileId, answer, previousAnswer (null the first time) }. */
  installationAnswered: 'installation_answer.answered',
  /** ADR-042. Payload: { cadFileId, routeHandle, lengthM }. */
  trenchMarkAdded: 'trench_mark.added',
  /** ADR-042. Payload: { cadFileId, routeHandle, lengthM }. */
  trenchMarkWithdrawn: 'trench_mark.withdrawn',
  /**
   * ADR-043, one per row written. Payload: { cadFileId, shape, workOrderLineId (null = cleared),
   * previousWorkOrderLineId (null the first time), fromPreviousVersion: boolean }.
   */
  boxTypeChosen: 'box_type_choice.chosen',
  designRevisionQueued: 'design_revision.queued',
  /** Written by the worker (actor_id NULL). */
  designRevisionBuildStarted: 'design_revision.build_started',
  designRevisionBuilt: 'design_revision.built',
  designRevisionFailed: 'design_revision.failed',
  designRevisionPublished: 'design_revision.published',
  designRevisionDiscarded: 'design_revision.discarded',
  /** ADR-034. Payload: { code, handle, layer, acceptResponsibility: true }. */
  designRevisionProblemIgnored: 'design_revision.problem_ignored',
  /** Payload: { before: {status, featureId}, after: {status, featureId} }. */
  textLinkReviewed: 'text_link.reviewed',
  /** Payload: clientOpId, deviceId, featureId, lines, flags (Phase 3). */
  executionUpdateRecorded: 'execution_update.recorded',
  /** Payload: updateId, sha256, sizeBytes. */
  executionPhotoStored: 'execution_photo.stored',
  /** Phase 2 (ADR-027). Contract events have project_id NULL: a contract sits above projects. */
  contractCreated: 'contract.created',
  contractUpdated: 'contract.updated',
  /** BOQ replaced by an Excel import; payload: file sha256, sheet, mapping, item/heading counts, total. */
  contractImported: 'contract.imported',
  /** Payload: full snapshot of the approved BOQ (lines, total). */
  contractApproved: 'contract.approved',
  contractItemAdded: 'contract_item.added',
  contractItemUpdated: 'contract_item.updated',
  contractItemRemoved: 'contract_item.removed',
  contractAttachmentAdded: 'contract_attachment.added',
  contractAttachmentRemoved: 'contract_attachment.removed',
  /** Phase 4 (ADR-030). Payload: clientOpId, deviceId, featureId, kind, baseVersion, geometry, label, lengthM, flags. */
  asBuiltEditRecorded: 'asbuilt_edit.recorded',
  /** Payload: featureId, kind, approvedVersion, lengthM. */
  asBuiltEditApproved: 'asbuilt_edit.approved',
  /** Payload: featureId, kind, reason. */
  asBuiltEditRejected: 'asbuilt_edit.rejected',
  asBuiltExportRequested: 'asbuilt_export.requested',
  /** Written by the worker (actor_id NULL). Payload: stats, sizeBytes. */
  asBuiltExportDone: 'asbuilt_export.done',
  asBuiltExportFailed: 'asbuilt_export.failed',
  /** Phase 2 subcontractors (ADR-036). Contractor list events have project_id NULL. */
  contractorCreated: 'contractor.created',
  contractorUpdated: 'contractor.updated',
  /** Payload: contractorId, registeredOn, lines (workOrderItemId, quantity, unitPrice). */
  contractorRegistered: 'contractor_registration.registered',
  /** Payload: full snapshot of the registration (lines and price history); rows are deleted. */
  contractorRegistrationRemoved: 'contractor_registration.removed',
  contractorLineAdded: 'contractor_line.added',
  /** Payload: { before, after } quantity. */
  contractorLineUpdated: 'contractor_line.updated',
  /** Payload: snapshot of the line and its prices. */
  contractorLineRemoved: 'contractor_line.removed',
  /** Payload: effectiveFrom, unitPrice, previous price. */
  contractorPriceAdded: 'contractor_line.price_added',
} as const;
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
