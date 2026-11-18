'use client';

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { errorCodeOf, errorReasonOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { usePreviewSitesTable, useReplaceSites, useWorkOrderSites } from '../api/queries';
import {
  addRow,
  mergeTableNames,
  removeRow,
  renameRow,
  rowsChanged,
  rowsFromSites,
  sitesPayload,
  tooManyRows,
  validateRows,
  type SiteRow,
  type SiteRowErrors,
} from '../model/sites-editor';

/** State of the sites panel (ADR-049): typed rows, rows from a table, save. */
export function useSitesEditor(projectId: string, workOrderId: string, version: number) {
  const query = useWorkOrderSites(projectId, workOrderId);
  const replace = useReplaceSites(projectId, workOrderId);
  const preview = usePreviewSitesTable(projectId, workOrderId);
  const saved = useMemo(() => query.data?.items ?? [], [query.data]);

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<SiteRow[]>([]);
  const [errors, setErrors] = useState<SiteRowErrors>({});
  const [tableNote, setTableNote] = useState<{ added: number; skipped: number } | null>(null);
  const [tableErrorCode, setTableErrorCode] = useState<ClientErrorCode | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<ClientErrorCode | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!editing) setRows(rowsFromSites(saved));
  }, [saved, editing]);

  const start = useCallback(() => {
    setRows(rowsFromSites(saved));
    setErrors({});
    setTableNote(null);
    setTableErrorCode(null);
    setSaveErrorCode(null);
    setConflict(false);
    setEditing(true);
  }, [saved]);

  const cancel = useCallback(() => {
    setEditing(false);
    setRows(rowsFromSites(saved));
    setErrors({});
  }, [saved]);

  const onRename = (key: string) => (event: ChangeEvent<HTMLInputElement>) =>
    setRows((current) => renameRow(current, key, event.target.value));
  const onAdd = () => setRows((current) => addRow(current));
  const onRemove = (key: string) => setRows((current) => removeRow(current, key));

  const onTableFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setTableErrorCode(null);
    setTableNote(null);
    try {
      const result = await preview.mutateAsync(file);
      const merged = mergeTableNames(rows, result.names);
      setRows(merged.rows);
      setTableNote({
        added: result.names.length - merged.skipped,
        skipped: merged.skipped + result.repeated.length,
      });
    } catch (error) {
      setTableErrorCode(errorCodeOf(error));
    }
  };

  const save = async () => {
    const found = validateRows(rows);
    setErrors(found);
    if (Object.keys(found).length > 0 || tooManyRows(rows)) return;
    setSaveErrorCode(null);
    setConflict(false);
    try {
      await replace.mutateAsync(sitesPayload(rows, version));
      setEditing(false);
    } catch (error) {
      if (
        errorReasonOf(error) === 'VERSION_MISMATCH' ||
        errorReasonOf(error) === 'SITE_NOT_FOUND'
      ) {
        setConflict(true);
      } else {
        setSaveErrorCode(errorCodeOf(error));
      }
    }
  };

  const reload = async () => {
    await query.refetch();
    setEditing(false);
    setConflict(false);
  };

  return {
    saved,
    loading: query.isPending,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    editing,
    rows,
    errors,
    tooMany: tooManyRows(rows),
    changed: rowsChanged(rows, saved),
    readingTable: preview.isPending,
    tableNote,
    tableErrorCode,
    saving: replace.isPending,
    saveErrorCode,
    conflict,
    start,
    cancel,
    onRename,
    onAdd,
    onRemove,
    onTableFile,
    save,
    reload,
  };
}
