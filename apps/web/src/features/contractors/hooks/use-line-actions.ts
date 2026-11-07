'use client';

import { useState, type FormEvent } from 'react';
import type {
  ContractorLine,
  ContractorLineAvailability,
  ContractorRegistration,
} from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  useAddContractorPrice,
  useRemoveContractorLine,
  useRemoveRegistration,
  useUpdateContractorLine,
} from '../api/queries';
import { contractorErrorMsg } from '../model/contractor-errors';
import {
  validateLineQuantity,
  validatePriceForm,
  type Msg,
  type PriceFormErrors,
  type PriceFormValues,
} from '../model/contractor-forms';

export interface Editor {
  kind: 'quantity' | 'price';
  registrationId: string;
  lineId: string;
}

const EMPTY_PRICE: PriceFormValues = { effectiveFrom: '', unitPrice: '' };

/** Per-line and per-registration actions of the admin: edit quantity, add a price, remove. */
export function useLineActions(
  projectId: string,
  availability: readonly ContractorLineAvailability[],
) {
  const { t } = useI18n();
  const updateLine = useUpdateContractorLine(projectId);
  const addPrice = useAddContractorPrice(projectId);
  const removeLine = useRemoveContractorLine(projectId);
  const removeRegistration = useRemoveRegistration(projectId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [quantity, setQuantity] = useState('');
  const [quantityError, setQuantityError] = useState<Msg | null>(null);
  const [price, setPrice] = useState<PriceFormValues>(EMPTY_PRICE);
  const [priceErrors, setPriceErrors] = useState<PriceFormErrors>({});
  const [actionError, setActionError] = useState<Msg | null>(null);

  const fail = (error: unknown) => setActionError(contractorErrorMsg(error));
  const close = () => {
    setEditor(null);
    setQuantityError(null);
    setPriceErrors({});
    setActionError(null);
  };

  const openQuantity = (registration: ContractorRegistration, line: ContractorLine) => {
    close();
    setQuantity(line.quantity);
    setEditor({ kind: 'quantity', registrationId: registration.id, lineId: line.id });
  };

  const openPrice = (registration: ContractorRegistration, line: ContractorLine) => {
    close();
    setPrice(EMPTY_PRICE);
    setEditor({ kind: 'price', registrationId: registration.id, lineId: line.id });
  };

  const submitQuantity = (event: FormEvent, line: ContractorLine) => {
    event.preventDefault();
    if (!editor) return;
    const result = validateLineQuantity(
      quantity,
      line,
      availability.find((entry) => entry.workOrderItemId === line.workOrderItemId),
    );
    if (!result.ok) {
      setQuantityError(result.error);
      return;
    }
    setActionError(null);
    updateLine.mutate(
      {
        registrationId: editor.registrationId,
        lineId: line.id,
        body: { quantity: result.quantity },
      },
      { onSuccess: close, onError: fail },
    );
  };

  const submitPrice = (event: FormEvent, line: ContractorLine) => {
    event.preventDefault();
    if (!editor) return;
    const result = validatePriceForm(
      price,
      line,
      availability.find((entry) => entry.workOrderItemId === line.workOrderItemId),
    );
    if (!result.ok) {
      setPriceErrors(result.errors);
      return;
    }
    setActionError(null);
    addPrice.mutate(
      { registrationId: editor.registrationId, lineId: line.id, body: result.payload },
      { onSuccess: close, onError: fail },
    );
  };

  const onRemoveLine = (registration: ContractorRegistration, line: ContractorLine) => {
    if (!window.confirm(t('contractors.line.confirmRemove', { code: line.code }))) return;
    setActionError(null);
    removeLine.mutate(
      { registrationId: registration.id, lineId: line.id },
      { onSuccess: close, onError: fail },
    );
  };

  const onRemoveRegistration = (registration: ContractorRegistration) => {
    const name = registration.contractor.name;
    if (!window.confirm(t('contractors.section.confirmRemoveRegistration', { name }))) return;
    setActionError(null);
    removeRegistration.mutate(registration.id, { onSuccess: close, onError: fail });
  };

  return {
    editor,
    quantity,
    quantityError,
    price,
    priceErrors,
    actionError,
    pending:
      updateLine.isPending ||
      addPrice.isPending ||
      removeLine.isPending ||
      removeRegistration.isPending,
    onQuantityChange: (value: string) => {
      setQuantity(value);
      setQuantityError(null);
    },
    onPriceChange: (field: keyof PriceFormValues, value: string) => {
      setPrice((current) => ({ ...current, [field]: value }));
      setPriceErrors((current) => ({ ...current, [field]: undefined }));
    },
    openQuantity,
    openPrice,
    close,
    submitQuantity,
    submitPrice,
    onRemoveLine,
    onRemoveRegistration,
  };
}

export type LineActionsModel = ReturnType<typeof useLineActions>;
