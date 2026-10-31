'use client';

import { useState, type FormEvent } from 'react';
import type { ContractDetail, ContractItem } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import {
  useApproveContract,
  useContract,
  useRemoveContractItem,
  useUpdateContract,
} from '../api/queries';
import {
  contractErrorKey,
  contractToForm,
  validateUpdateContract,
  type ContractField,
  type ContractFormErrors,
  type ContractFormValues,
  type LineKind,
} from '../model/contract-forms';

export type LineEditor =
  { mode: 'add'; kind: LineKind } | { mode: 'edit'; item: ContractItem } | null;

/** Header edit form: allowed in every status, but the currency never changes. */
function useHeaderEditor(contractId: string, contract: ContractDetail | undefined) {
  const update = useUpdateContract(contractId);
  const [values, setValues] = useState<ContractFormValues | null>(null);
  const [errors, setErrors] = useState<ContractFormErrors>({});

  const onChange = (field: ContractField, value: string) => {
    setValues((current) =>
      current && field !== 'currency' ? { ...current, [field]: value } : current,
    );
    setErrors((current) => ({ ...current, [field]: undefined }));
    update.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!values || !contract) return;
    const result = validateUpdateContract(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    update.mutate(
      { ...result.payload, expectedVersion: contract.version },
      { onSuccess: () => setValues(null) },
    );
  };

  return {
    editing: values !== null,
    values,
    errors,
    pending: update.isPending,
    errorKey: update.error ? contractErrorKey(update.error) : null,
    start: () => {
      if (contract) setValues(contractToForm(contract));
      setErrors({});
      update.reset();
    },
    cancel: () => {
      setValues(null);
      update.reset();
    },
    onChange,
    onSubmit,
  };
}

/** Contract detail for the admin: header, BOQ line editor, delete line, approval. */
export function useContractDetail(contractId: string) {
  const query = useContract(contractId);
  const contract = query.data;
  const header = useHeaderEditor(contractId, contract);
  const remove = useRemoveContractItem(contractId);
  const approve = useApproveContract(contractId);
  const [lineEditor, setLineEditor] = useState<LineEditor>(null);
  const [confirmItemId, setConfirmItemId] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const draft = contract?.status === 'draft';

  return {
    contract,
    loading: query.isPending,
    loadErrorKey: query.error ? contractErrorKey(query.error) : null,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    reload: () => query.refetch(),
    /** BOQ edits exist only for a draft. */
    canEditBoq: draft === true,
    header,
    lineEditor,
    openAddLine: (kind: LineKind) => setLineEditor({ mode: 'add', kind }),
    openEditLine: (item: ContractItem) => {
      setConfirmItemId(null);
      setLineEditor({ mode: 'edit', item });
    },
    closeLineEditor: () => setLineEditor(null),
    confirmItemId,
    askDeleteLine: setConfirmItemId,
    deletingLine: remove.isPending,
    deleteLine: (item: ContractItem) => {
      if (!contract) return;
      remove.mutate(
        { itemId: item.id, expectedVersion: contract.version },
        { onSettled: () => setConfirmItemId(null) },
      );
    },
    lineActionErrorKey: remove.error ? contractErrorKey(remove.error) : null,
    approving,
    askApprove: (open: boolean) => {
      setApproving(open);
      approve.reset();
    },
    approvePending: approve.isPending,
    approveErrorKey: approve.error ? contractErrorKey(approve.error) : null,
    approve: () => {
      if (!contract) return;
      approve.mutate(contract.version, { onSuccess: () => setApproving(false) });
    },
  };
}

export type ContractDetailModel = ReturnType<typeof useContractDetail>;
