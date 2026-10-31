'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ContractItemAvailability, WorkOrderItem } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useProject } from '@/features/projects/hooks/project-access-context';
import {
  useContractItems,
  useDeleteItem,
  useDeleteWorkOrder,
  useUpdateWorkOrder,
  useWorkOrder,
} from '../api/queries';
import { headerChanges, headerToFormValues, validateHeader } from '../model/header-form';
import { useHeaderForm } from './use-header-form';

export type ItemEditor = { mode: 'add' } | { mode: 'edit'; item: WorkOrderItem } | null;

/** State for the work-order detail screen: header editing, item editor, delete confirmations. */
export function useWorkOrderDetail(projectId: string, workOrderId: string) {
  const { locale } = useI18n();
  const router = useRouter();
  const { can } = useProject();
  const canRead = can('work_orders:read');
  const query = useWorkOrder(projectId, workOrderId, canRead);
  const update = useUpdateWorkOrder(projectId, workOrderId);
  const removeOrder = useDeleteWorkOrder(projectId, workOrderId);
  const removeItem = useDeleteItem(projectId, workOrderId);

  const form = useHeaderForm({ number: '', title: '', issuedOn: '', notes: '' });
  const [editingHeader, setEditingHeader] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [itemEditor, setItemEditor] = useState<ItemEditor>(null);
  const [confirmItemId, setConfirmItemId] = useState<string | null>(null);
  const [confirmOrder, setConfirmOrder] = useState(false);

  const data = query.data;

  // Contract quantities per contract item (writers only; the endpoint needs work_orders:write).
  // A failure (e.g. the contract is no longer approved) only hides the extra columns.
  const availability = useContractItems(projectId, can('work_orders:write'));
  const availabilityItems = useMemo(() => availability.data?.items ?? [], [availability.data]);
  const availabilityByContractItem = useMemo(
    () =>
      new Map<string, ContractItemAvailability>(
        availabilityItems.map((item) => [item.contractItemId, item]),
      ),
    [availabilityItems],
  );
  const contractItemIdsInOrder = useMemo(
    () =>
      new Set(
        (data?.items ?? []).flatMap((item) => (item.contractItemId ? [item.contractItemId] : [])),
      ),
    [data],
  );

  const startEditHeader = () => {
    if (!data) return;
    form.reset(headerToFormValues(data));
    setConflict(false);
    update.reset();
    setEditingHeader(true);
  };

  const saveHeader = (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    const errors = validateHeader(form.values);
    form.setErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const changes = headerChanges(data, form.values);
    if (!changes) {
      setEditingHeader(false);
      return;
    }
    update.mutate(changes, {
      onSuccess: () => setEditingHeader(false),
      onError: (error) => setConflict(errorCodeOf(error) === 'CONFLICT'),
    });
  };

  /** After a version conflict: load the latest version and restart the edit from it. */
  const reload = async () => {
    const fresh = await query.refetch();
    if (fresh.data) form.reset(headerToFormValues(fresh.data));
    setConflict(false);
    update.reset();
  };

  const deleteOrder = () => {
    removeOrder.mutate(undefined, {
      onSuccess: () => router.push(`/${locale}/projects/${projectId}/work-orders`),
    });
  };

  const deleteItem = (itemId: string) => {
    removeItem.mutate(itemId, { onSettled: () => setConfirmItemId(null) });
  };

  const actionError = removeOrder.error ?? removeItem.error;
  return {
    canRead,
    canWrite: can('work_orders:write'),
    workOrder: data ?? null,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    form,
    editingHeader,
    startEditHeader,
    cancelEditHeader: () => setEditingHeader(false),
    saveHeader,
    savingHeader: update.isPending,
    headerErrorCode: update.error && !conflict ? errorCodeOf(update.error) : null,
    conflict,
    reload,
    itemEditor,
    openAddItem: () => setItemEditor({ mode: 'add' }),
    openEditItem: (item: WorkOrderItem) => setItemEditor({ mode: 'edit', item }),
    closeItemEditor: () => setItemEditor(null),
    confirmItemId,
    askDeleteItem: setConfirmItemId,
    deleteItem,
    deletingItem: removeItem.isPending,
    confirmOrder,
    askDeleteOrder: setConfirmOrder,
    deleteOrder,
    deletingOrder: removeOrder.isPending,
    actionError,
    availabilityItems,
    availabilityByContractItem,
    contractItemIdsInOrder,
  };
}
