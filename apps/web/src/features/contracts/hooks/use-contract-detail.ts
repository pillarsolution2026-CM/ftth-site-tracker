'use client';

import { useState, type FormEvent } from 'react';
import type { ContractDetail, ContractItem } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import {
  useApproveContract,
  useContract,
  useRemoveContractItem,
  useSetItemGroup,
  useUpdateContract,
} from '../api/queries';
import {
  contractErrorKey,
  contractToForm,
  ungroupedCodesOf,
  validateGroupForm,
  type GroupFormErrors,
  type GroupFormValues,
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

/** Group editor of one priced line (ADR-048): allowed for draft and approved contracts. */
function useGroupEditor(contractId: string, contract: ContractDetail | undefined) {
  const mutation = useSetItemGroup(contractId);
  const [item, setItem] = useState<ContractItem | null>(null);
  const [values, setValues] = useState<GroupFormValues>({ main: '', sub: '' });
  const [errors, setErrors] = useState<GroupFormErrors>({});

  const close = () => {
    setItem(null);
    mutation.reset();
  };
  const send = (itemId: string, main: string | null, sub: string | null) => {
    if (!contract) return;
    mutation.mutate(
      { itemId, body: { main, sub, expectedVersion: contract.version } },
      { onSuccess: close },
    );
  };

  return {
    item,
    values,
    errors,
    pending: mutation.isPending,
    errorKey: mutation.error ? contractErrorKey(mutation.error) : null,
    open: (target: ContractItem) => {
      const group = target.group?.group;
      setValues({ main: group?.main ?? '', sub: group?.sub ?? '' });
      setErrors({});
      mutation.reset();
      setItem(target);
    },
    close,
    onChange: (field: keyof GroupFormValues, value: string) => {
      setValues((current) => ({ ...current, [field]: value }));
      setErrors((current) => ({ ...current, [field]: undefined }));
      mutation.reset();
    },
    save: () => {
      if (!item) return;
      const result = validateGroupForm(values);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      send(item.id, result.main, result.sub);
    },
    /** Remove the manual choice: the line goes back to the rule. */
    resetToRule: () => {
      if (item) send(item.id, null, null);
    },
  };
}

/** Contract detail for the admin: header, BOQ line editor, delete line, approval. */
export function useContractDetail(contractId: string) {
  const query = useContract(contractId);
  const contract = query.data;
  const header = useHeaderEditor(contractId, contract);
  const remove = useRemoveContractItem(contractId);
  const approve = useApproveContract(contractId);
  const groupEditor = useGroupEditor(contractId, contract);
  const [onlyUngrouped, setOnlyUngrouped] = useState(false);
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
    groupEditor,
    onlyUngrouped,
    toggleOnlyUngrouped: () => setOnlyUngrouped((current) => !current),
    approvePending: approve.isPending,
    approveErrorKey: approve.error ? contractErrorKey(approve.error) : null,
    approveUngroupedCodes: approve.error ? ungroupedCodesOf(approve.error) : [],
    approve: () => {
      if (!contract) return;
      approve.mutate(contract.version, { onSuccess: () => setApproving(false) });
    },
  };
}

export type ContractDetailModel = ReturnType<typeof useContractDetail>;
