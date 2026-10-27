import type { Readable } from 'node:stream';
import { EVENT_ENTITIES, EVENT_TYPES, PDF_CONTENT_TYPE } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import { peekStream } from '../../../common/storage/peek-stream.js';
import { extensionOf, hasPdfSignature } from '../domain/file-signatures.js';
import type {
  WorkOrderAttachment,
  WorkOrderAttachmentRepository,
  WorkOrderRepository,
  WorkOrderUnitOfWork,
} from '../domain/work-order.repository.js';

async function requireOrder(
  orders: WorkOrderRepository,
  projectId: string,
  id: string,
): Promise<void> {
  if (!(await orders.exists(projectId, id)))
    throw new AppError('NOT_FOUND', 'Work order not found');
}

export class ListAttachmentsUseCase {
  constructor(
    private readonly orders: WorkOrderRepository,
    private readonly attachments: WorkOrderAttachmentRepository,
  ) {}

  async execute(projectId: string, workOrderId: string): Promise<WorkOrderAttachment[]> {
    await requireOrder(this.orders, projectId, workOrderId);
    return this.attachments.listByWorkOrder(projectId, workOrderId);
  }
}

export class AddAttachmentUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly orders: WorkOrderRepository,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly maxBytes: number,
  ) {}

  async execute(input: {
    projectId: string;
    workOrderId: string;
    actorId: string;
    file: { fileName: string; stream: Readable };
  }): Promise<WorkOrderAttachment> {
    const { projectId, workOrderId, actorId, file } = input;
    await requireOrder(this.orders, projectId, workOrderId);

    const { head, stream } = await peekStream(file.stream, 8);
    if (extensionOf(file.fileName) !== 'pdf' || !hasPdfSignature(head)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only PDF documents can be attached');
    }

    const id = this.ids.next();
    const storageKey = storageKeys.workOrderAttachment(projectId, workOrderId, id, 'pdf');
    const stored = await this.storage.put(storageKey, stream, {
      contentType: PDF_CONTENT_TYPE,
      maxBytes: this.maxBytes,
    });
    const attachment: WorkOrderAttachment = {
      id,
      projectId,
      workOrderId,
      kind: 'document',
      fileName: file.fileName,
      contentType: PDF_CONTENT_TYPE,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey,
      uploadedById: actorId,
      createdAt: this.clock.now(),
    };
    try {
      await this.uow.run(async (tx) => {
        await tx.attachments.insert(attachment);
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.workOrderAttachment,
          entityId: id,
          type: EVENT_TYPES.workOrderAttachmentAdded,
          actorId,
          payload: {
            workOrderId,
            kind: attachment.kind,
            fileName: attachment.fileName,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
          },
        });
      });
    } catch (error) {
      await discardObject(this.storage, storageKey);
      throw error;
    }
    return attachment;
  }
}

export class GetAttachmentContentUseCase {
  constructor(
    private readonly attachments: WorkOrderAttachmentRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    projectId: string,
    workOrderId: string,
    attachmentId: string,
  ): Promise<{ attachment: WorkOrderAttachment; stream: Readable }> {
    const attachment = await this.attachments.find(projectId, workOrderId, attachmentId);
    if (!attachment) throw new AppError('NOT_FOUND', 'Attachment not found');
    return { attachment, stream: await this.storage.get(attachment.storageKey) };
  }
}

export class DeleteAttachmentUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(input: {
    projectId: string;
    workOrderId: string;
    attachmentId: string;
    actorId: string;
  }): Promise<void> {
    const { projectId, workOrderId, attachmentId, actorId } = input;
    const storageKey = await this.uow.run(async (tx) => {
      const attachment = await tx.attachments.find(projectId, workOrderId, attachmentId);
      if (!attachment) throw new AppError('NOT_FOUND', 'Attachment not found');
      if (attachment.kind === 'import_source') {
        throw new AppError('CONFLICT', 'The imported source file cannot be deleted', {
          reason: 'IMPORT_SOURCE_PROTECTED',
        });
      }
      await tx.attachments.delete(projectId, workOrderId, attachmentId);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrderAttachment,
        entityId: attachmentId,
        type: EVENT_TYPES.workOrderAttachmentRemoved,
        actorId,
        payload: {
          workOrderId,
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
        },
      });
      return attachment.storageKey;
    });
    await discardObject(this.storage, storageKey);
  }
}
