import type { BoxShapeGallery, BoxShapeSignature } from '@ftth/shared';

/** One row of `cad_file_box_type_choices` (ADR-043). Dates are real dates here. */
export interface BoxTypeChoiceRow {
  id: string;
  projectId: string;
  cadFileId: string;
  shape: BoxShapeSignature;
  /** null = cleared. */
  workOrderLineId: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
}

export type NewBoxTypeChoice = Pick<
  BoxTypeChoiceRow,
  'id' | 'projectId' | 'cadFileId' | 'shape' | 'workOrderLineId' | 'createdAt'
> & { createdById: string };

/** Every method filters by `projectId` (IDOR defence). */
export interface BoxTypeRepository {
  /** Every row of the file, newest first (`seq` DESC). */
  listChoices(projectId: string, cadFileId: string): Promise<BoxTypeChoiceRow[]>;
  /** In the given order (the table's `seq` follows it). */
  insertChoices(choices: NewBoxTypeChoice[]): Promise<void>;
  /**
   * The gallery of the file's latest draft or published revision (newest first); null when there is
   * no such revision or it has no gallery.
   */
  latestBuiltGallery(projectId: string, cadFileId: string): Promise<BoxShapeGallery | null>;
  /** The file this one superseded (the previous version of the Secondary), or null. */
  previousVersionFileId(projectId: string, cadFileId: string): Promise<string | null>;
}
