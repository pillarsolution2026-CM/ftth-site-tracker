import { and, desc, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { contractAttachments } from '../../../db/schema.js';
import type {
  ContractAttachment,
  ContractAttachmentRepository,
} from '../domain/contract.repository.js';

type Row = typeof contractAttachments.$inferSelect;

const toAttachment = (row: Row): ContractAttachment => ({
  id: row.id,
  contractId: row.contractId,
  kind: row.kind,
  fileName: row.fileName,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  storageKey: row.storageKey,
  uploadedById: row.uploadedBy,
  createdAt: row.createdAt,
});

export class DrizzleContractAttachmentRepository implements ContractAttachmentRepository {
  constructor(private readonly db: DbHandle) {}

  async listByContract(contractId: string): Promise<ContractAttachment[]> {
    const rows = await this.db
      .select()
      .from(contractAttachments)
      .where(eq(contractAttachments.contractId, contractId))
      .orderBy(desc(contractAttachments.createdAt), desc(contractAttachments.id));
    return rows.map(toAttachment);
  }

  async find(contractId: string, attachmentId: string): Promise<ContractAttachment | null> {
    const [row] = await this.db
      .select()
      .from(contractAttachments)
      .where(
        and(
          eq(contractAttachments.contractId, contractId),
          eq(contractAttachments.id, attachmentId),
        ),
      );
    return row ? toAttachment(row) : null;
  }

  async insert(attachment: ContractAttachment): Promise<void> {
    await this.db.insert(contractAttachments).values({
      id: attachment.id,
      contractId: attachment.contractId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      storageKey: attachment.storageKey,
      uploadedBy: attachment.uploadedById,
      createdAt: attachment.createdAt,
    });
  }

  async delete(contractId: string, attachmentId: string): Promise<void> {
    await this.db
      .delete(contractAttachments)
      .where(
        and(
          eq(contractAttachments.contractId, contractId),
          eq(contractAttachments.id, attachmentId),
        ),
      );
  }
}
