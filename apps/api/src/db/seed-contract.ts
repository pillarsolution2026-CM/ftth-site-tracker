import { eq } from 'drizzle-orm';
import type { Database } from './db.module.js';
import { contractItems, contracts, projects, workOrderItems, workOrders } from './schema.js';

/**
 * Development BOQ: priced items and headings. Prices and quantities are made up for the seed; they
 * are not business data (rule 10).
 */
const DEV_CONTRACT_NUMBER = 'DEV-CONTRACT-1';
const DEV_WORK_ORDER_NUMBER = 'DEV-WO-1';

interface DevItem {
  code: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  workType: 'civil' | 'installation' | 'planning';
  /** Quantity the dev work order takes (a third of the contract). */
  orderQuantity: string;
}

const DEV_ITEMS: readonly DevItem[] = [
  {
    code: '1-1',
    description: 'حفر خندق',
    unit: 'م.ط',
    quantity: '3000',
    unitPrice: '12.5',
    workType: 'civil',
    orderQuantity: '1000',
  },
  {
    code: '1-2',
    description: 'غرفة تفتيش',
    unit: 'عدد',
    quantity: '300',
    unitPrice: '8000',
    workType: 'civil',
    orderQuantity: '100',
  },
  {
    code: '2-1',
    description: 'مد كابل',
    unit: 'م.ط',
    quantity: '9000',
    unitPrice: '2',
    workType: 'installation',
    orderQuantity: '3000',
  },
];

/**
 * Approved dev contract with a BOQ, linked to `projectId`, plus the project's work order built
 * from it (ADR-028). Idempotent: does nothing for what already exists.
 */
export async function seedContractAndWorkOrder(db: Database, projectId: string): Promise<void> {
  let [contract] = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(eq(contracts.number, DEV_CONTRACT_NUMBER));
  if (!contract) {
    [contract] = await db
      .insert(contracts)
      .values({ number: DEV_CONTRACT_NUMBER, name: 'عقد تجريبي', client: 'WE', currency: 'EGP' })
      .returning({ id: contracts.id });
    if (!contract) throw new Error('contract insert returned no row');
    const contractId = contract.id;
    // Lines first (a draft contract takes them), then approval locks the BOQ.
    await db.insert(contractItems).values([
      { contractId, lineNo: 1, kind: 'heading', code: '1', description: 'الأعمال المدنية' },
      ...DEV_ITEMS.slice(0, 2).map((item, index) => ({
        contractId,
        lineNo: index + 2,
        kind: 'item' as const,
        ...item,
      })),
      { contractId, lineNo: 4, kind: 'heading', code: '2', description: 'أعمال التركيبات' },
      ...DEV_ITEMS.slice(2).map((item, index) => ({
        contractId,
        lineNo: index + 5,
        kind: 'item' as const,
        ...item,
      })),
    ]);
    await db
      .update(contracts)
      .set({ status: 'approved', approvedAt: new Date() })
      .where(eq(contracts.id, contractId));
  }
  const contractId = contract.id;

  await db.update(projects).set({ contractId }).where(eq(projects.id, projectId));

  const [existing] = await db
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(eq(workOrders.projectId, projectId));
  if (existing) return;

  const rows = await db
    .select()
    .from(contractItems)
    .where(eq(contractItems.contractId, contractId));
  const [order] = await db
    .insert(workOrders)
    .values({ projectId, number: DEV_WORK_ORDER_NUMBER, currency: 'EGP' })
    .returning({ id: workOrders.id });
  if (!order) throw new Error('work order insert returned no row');
  const workOrderId = order.id;
  const lines = rows
    .filter((row) => row.kind === 'item')
    .sort((a, b) => a.lineNo - b.lineNo)
    .flatMap((row, index) => {
      const dev = DEV_ITEMS.find((item) => item.code === row.code);
      if (!dev) return [];
      return [
        {
          projectId,
          workOrderId,
          lineNo: index + 1,
          code: row.code,
          description: row.description ?? '',
          unit: row.unit ?? '',
          quantity: dev.orderQuantity,
          unitPrice: row.unitPrice ?? '0',
          workType: row.workType,
          contractId,
          contractItemId: row.id,
        },
      ];
    });
  await db.insert(workOrderItems).values(lines);
}
