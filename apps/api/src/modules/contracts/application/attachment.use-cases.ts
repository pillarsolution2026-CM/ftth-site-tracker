import type { Readable } from 'node:stream';
import { EVENT_ENTITIES, EVENT_TYPES, PDF_CONTENT_TYPE } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import { peekStream } from '../../../common/storage/peek-stream.js';
import { extensionOf, hasPdfSignature } from '../../work-orders/domain/file-signatures.js';
import type {
  ContractAttachment,
  ContractAttachmentRepository,
  ContractRepository,
  ContractUnitOfWork,
} from '../domain/contract.repository.js';

/** Contract PDF (the signed contract). Allowed in any status: it is a document, not the BOQ. */
export class AddContractAttachmentUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly contracts: ContractRepository,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly maxBytes: number,
  ) {}

  async execute(input: {
    contractId: string;
    actorId: string;
    file: { fileName: string; stream: Readable };
  }): Promise<ContractAttachment> {
    const { contractId, actorId, file } = input;
    if (!(await this.contracts.exists(contractId))) {
      throw new AppError('NOT_FOUND', 'Contract not found');
    }

    const { head, stream } = await peekStream(file.stream, 8);
    if (extensionOf(file.fileName) !== 'pdf' || !hasPdfSignature(head)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only PDF documents can be attached');
    }

    const id = this.ids.next();
    const storageKey = storageKeys.contractAttachment(contractId, id, 'pdf');
    const stored = await this.storage.put(storageKey, stream, {
      contentType: PDF_CONTENT_TYPE,
      maxBytes: this.maxBytes,
    });
    const attachment: ContractAttachment = {
      id,
      contractId,
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
          projectId: null,
          entity: EVENT_ENTITIES.contractAttachment,
          entityId: id,
          type: EVENT_TYPES.contractAttachmentAdded,
          actorId,
          payload: {
            contractId,
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

export class GetContractAttachmentContentUseCase {
  constructor(
    private readonly attachments: ContractAttachmentRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    contractId: string,
    attachmentId: string,
  ): Promise<{ attachment: ContractAttachment; stream: Readable }> {
    const attachment = await this.attachments.find(contractId, attachmentId);
    if (!attachment) throw new AppError('NOT_FOUND', 'Attachment not found');
    return { attachment, stream: await this.storage.get(attachment.storageKey) };
  }
}

export class DeleteContractAttachmentUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(input: {
    contractId: string;
    attachmentId: string;
    actorId: string;
  }): Promise<void> {
    const { contractId, attachmentId, actorId } = input;
    const storageKey = await this.uow.run(async (tx) => {
      const attachment = await tx.attachments.find(contractId, attachmentId);
      if (!attachment) throw new AppError('NOT_FOUND', 'Attachment not found');
      if (attachment.kind === 'import_source') {
        throw new AppError('CONFLICT', 'The imported source file cannot be deleted', {
          reason: 'IMPORT_SOURCE_PROTECTED',
        });
      }
      await tx.attachments.delete(contractId, attachmentId);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractAttachment,
        entityId: attachmentId,
        type: EVENT_TYPES.contractAttachmentRemoved,
        actorId,
        payload: {
          contractId,
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
