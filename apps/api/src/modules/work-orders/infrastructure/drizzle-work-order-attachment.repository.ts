import { and, desc, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { workOrderAttachments } from '../../../db/schema.js';
import type {
  WorkOrderAttachment,
  WorkOrderAttachmentRepository,
} from '../domain/work-order.repository.js';

type Row = typeof workOrderAttachments.$inferSelect;

const toAttachment = (row: Row): WorkOrderAttachment => ({
  id: row.id,
  projectId: row.projectId,
  workOrderId: row.workOrderId,
  kind: row.kind,
  fileName: row.fileName,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  storageKey: row.storageKey,
  uploadedById: row.uploadedBy,
  createdAt: row.createdAt,
});

const inOrder = (projectId: string, workOrderId: string) =>
  and(
    eq(workOrderAttachments.projectId, projectId),
    eq(workOrderAttachments.workOrderId, workOrderId),
  );

export class DrizzleWorkOrderAttachmentRepository implements WorkOrderAttachmentRepository {
  constructor(private readonly db: DbHandle) {}

  async listByWorkOrder(projectId: string, workOrderId: string): Promise<WorkOrderAttachment[]> {
    const rows = await this.db
      .select()
      .from(workOrderAttachments)
      .where(inOrder(projectId, workOrderId))
      .orderBy(desc(workOrderAttachments.createdAt), desc(workOrderAttachments.id));
    return rows.map(toAttachment);
  }

  async find(
    projectId: string,
    workOrderId: string,
    attachmentId: string,
  ): Promise<WorkOrderAttachment | null> {
    const [row] = await this.db
      .select()
      .from(workOrderAttachments)
      .where(and(inOrder(projectId, workOrderId), eq(workOrderAttachments.id, attachmentId)));
    return row ? toAttachment(row) : null;
  }

  async insert(attachment: WorkOrderAttachment): Promise<void> {
    await this.db.insert(workOrderAttachments).values({
      id: attachment.id,
      projectId: attachment.projectId,
      workOrderId: attachment.workOrderId,
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

  async delete(projectId: string, workOrderId: string, attachmentId: string): Promise<void> {
    await this.db
      .delete(workOrderAttachments)
      .where(and(inOrder(projectId, workOrderId), eq(workOrderAttachments.id, attachmentId)));
  }
}
