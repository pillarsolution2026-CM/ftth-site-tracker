import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CadWarning,
  CrsDetection,
  DesignRevisionCounts,
  DiffChange,
  DiffCounts,
  DrawingUnit,
  FeatureType,
  MappingRule,
  TextLinkCounts,
  TextLinkKind,
  TextLinkStatus,
} from '@ftth/shared';

/** PostGIS geometry in the project CRS. Spatial queries use `sql` templates in repositories only. */
const multiPolygon = customType<{ data: string }>({
  dataType: () => 'geometry(MultiPolygon)',
});

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  locale: text('locale').notNull().default('ar'),
  isAdmin: boolean('is_admin').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('refresh_tokens_family_idx').on(table.familyId)],
);

export const projects = pgTable('projects', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  client: text('client').notNull(),
  crsEpsg: integer('crs_epsg').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  locale: text('locale').notNull().default('ar'),
  /** FK to contracts (migration 0007, ADR-027); null only for projects created before Phase 2. */
  contractId: uuid('contract_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const zones = pgTable(
  'zones',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    geom: multiPolygon('geom'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('zones_project_id_id_key').on(table.projectId, table.id)],
);

export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    zoneId: uuid('zone_id'),
    contractorId: uuid('contractor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A zone must belong to the same project as the assignment (migration 0002).
    foreignKey({
      name: 'assignments_project_zone_fkey',
      columns: [table.projectId, table.zoneId],
      foreignColumns: [zones.projectId, zones.id],
    }).onDelete('cascade'),
  ],
);

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  projectId: uuid('project_id').references(() => projects.id),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  actorId: uuid('actor_id').references(() => users.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------------
// Phase 1a (migration 0003). `updated_at` is maintained by the set_updated_at() trigger; generated
// columns (amount, length, vertex_count) are read-only: never insert them.
// ---------------------------------------------------------------------------------------------

/** Drawing-coordinate geometries (SRID 0) of the raw CAD extraction; read through ST_* in repositories. */
const pointZ = customType<{ data: string }>({ dataType: () => 'geometry(PointZ, 0)' });
const lineStringZ = customType<{ data: string }>({ dataType: () => 'geometry(LineStringZ, 0)' });

export const workOrders = pgTable(
  'work_orders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    title: text('title'),
    issuedOn: date('issued_on', { mode: 'string' }),
    notes: text('notes'),
    currency: char('currency', { length: 3 }).notNull(),
    source: text('source').$type<'manual' | 'import'>().notNull().default('manual'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('work_orders_project_number_key').on(table.projectId, table.number),
    unique('work_orders_project_id_id_key').on(table.projectId, table.id),
    // One work order per project (migration 0008, ADR-028).
    unique('work_orders_one_per_project').on(table.projectId),
  ],
);

export const workOrderItems = pgTable(
  'work_order_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    workOrderId: uuid('work_order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    code: text('code').notNull(),
    description: text('description').notNull(),
    unit: text('unit').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }).notNull(),
    amount: numeric('amount', { precision: 38, scale: 10 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    /** null only for items saved before migration 0004 (ADR-016). */
    workType: text('work_type').$type<'civil' | 'installation' | 'planning'>(),
    source: text('source').$type<'manual' | 'import'>().notNull().default('manual'),
    sourceRow: integer('source_row'),
    /** Contract line this item comes from (migration 0008, ADR-028); null only for old lines. */
    contractId: uuid('contract_id'),
    contractItemId: uuid('contract_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'work_order_items_contract_item_fkey',
      columns: [table.contractId, table.contractItemId],
      foreignColumns: [contractItems.contractId, contractItems.id],
    }).onDelete('restrict'),
    check(
      'work_order_items_contract_link_both',
      sql`(${table.contractId} IS NULL) = (${table.contractItemId} IS NULL)`,
    ),
    uniqueIndex('work_order_items_order_contract_item_key')
      .on(table.workOrderId, table.contractItemId)
      .where(sql`${table.contractItemId} IS NOT NULL`),
    index('work_order_items_contract_item_idx')
      .on(table.contractItemId)
      .where(sql`${table.contractItemId} IS NOT NULL`),
    foreignKey({
      name: 'work_order_items_order_fkey',
      columns: [table.projectId, table.workOrderId],
      foreignColumns: [workOrders.projectId, workOrders.id],
    }).onDelete('cascade'),
    unique('work_order_items_line_no_key').on(table.workOrderId, table.lineNo),
    unique('work_order_items_project_id_id_key').on(table.projectId, table.id),
    index('work_order_items_order_code_idx').on(table.workOrderId, table.code),
    index('work_order_items_order_work_type_idx').on(table.workOrderId, table.workType),
  ],
);

export const workOrderAttachments = pgTable(
  'work_order_attachments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    workOrderId: uuid('work_order_id').notNull(),
    kind: text('kind').$type<'document' | 'import_source'>().notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'work_order_attachments_order_fkey',
      columns: [table.projectId, table.workOrderId],
      foreignColumns: [workOrders.projectId, workOrders.id],
    }).onDelete('cascade'),
    index('work_order_attachments_order_idx').on(table.workOrderId, table.createdAt),
  ],
);

export const cadFiles = pgTable(
  'cad_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    originalName: text('original_name').notNull(),
    format: text('format').$type<'dwg' | 'dxf'>().notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    convertedStorageKey: text('converted_storage_key'),
    status: text('status')
      .$type<'uploaded' | 'queued' | 'processing' | 'processed' | 'failed'>()
      .notNull()
      .default('uploaded'),
    currentJobId: uuid('current_job_id'),
    converter: text('converter').$type<'oda' | 'libredwg' | 'none'>(),
    converterVersion: text('converter_version'),
    dxfVersion: text('dxf_version'),
    insUnits: integer('ins_units'),
    extentsMinX: doublePrecision('extents_min_x'),
    extentsMinY: doublePrecision('extents_min_y'),
    extentsMaxX: doublePrecision('extents_max_x'),
    extentsMaxY: doublePrecision('extents_max_y'),
    layerCount: integer('layer_count'),
    insertCount: integer('insert_count'),
    textCount: integer('text_count'),
    curveCount: integer('curve_count'),
    warnings: jsonb('warnings').$type<CadWarning[]>().notNull().default([]),
    log: text('log'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Written by the worker (migration 0005); NULL for files processed before Phase 1b. */
    crsDetection: jsonb('crs_detection').$type<CrsDetection>(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    unique('cad_files_project_id_id_key').on(table.projectId, table.id),
    index('cad_files_project_created_idx').on(table.projectId, table.createdAt),
  ],
);

export const cadLayers = pgTable(
  'cad_layers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    cadFileId: uuid('cad_file_id').notNull(),
    name: text('name').notNull(),
    aciColor: smallint('aci_color').notNull(),
    trueColor: integer('true_color'),
    linetype: text('linetype'),
    isOn: boolean('is_on').notNull(),
    isFrozen: boolean('is_frozen').notNull(),
    isLocked: boolean('is_locked').notNull(),
    entityCounts: jsonb('entity_counts').$type<Record<string, number>>().notNull().default({}),
    entityTotal: integer('entity_total').notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: 'cad_layers_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('cascade'),
    unique('cad_layers_file_name_key').on(table.cadFileId, table.name),
  ],
);

export const cadInserts = pgTable(
  'cad_inserts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    cadFileId: uuid('cad_file_id').notNull(),
    handle: text('handle').notNull(),
    layer: text('layer').notNull(),
    blockName: text('block_name').notNull(),
    position: pointZ('position').notNull(),
    rotation: doublePrecision('rotation').notNull().default(0),
    scaleX: doublePrecision('scale_x').notNull().default(1),
    scaleY: doublePrecision('scale_y').notNull().default(1),
    scaleZ: doublePrecision('scale_z').notNull().default(1),
    aciColor: smallint('aci_color').notNull().default(256),
    attributes: jsonb('attributes')
      .$type<{ tag: string; rawValue: string; value: string; readable: boolean }[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    foreignKey({
      name: 'cad_inserts_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('cascade'),
    unique('cad_inserts_file_handle_key').on(table.cadFileId, table.handle),
    index('cad_inserts_file_layer_idx').on(table.cadFileId, table.layer),
  ],
);

export const cadTexts = pgTable(
  'cad_texts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    cadFileId: uuid('cad_file_id').notNull(),
    handle: text('handle').notNull(),
    kind: text('kind').$type<'text' | 'mtext'>().notNull(),
    layer: text('layer').notNull(),
    position: pointZ('position').notNull(),
    height: doublePrecision('height').notNull(),
    rotation: doublePrecision('rotation').notNull().default(0),
    rawText: text('raw_text').notNull(),
    text: text('text').notNull(),
    readable: boolean('readable').notNull(),
    style: text('style'),
    font: text('font'),
    aciColor: smallint('aci_color').notNull().default(256),
  },
  (table) => [
    foreignKey({
      name: 'cad_texts_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('cascade'),
    unique('cad_texts_file_handle_key').on(table.cadFileId, table.handle),
    index('cad_texts_file_layer_idx').on(table.cadFileId, table.layer),
  ],
);

export const cadCurves = pgTable(
  'cad_curves',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    cadFileId: uuid('cad_file_id').notNull(),
    handle: text('handle').notNull(),
    entityType: text('entity_type').notNull(),
    layer: text('layer').notNull(),
    geom: lineStringZ('geom').notNull(),
    isClosed: boolean('is_closed').notNull().default(false),
    flattenTolerance: doublePrecision('flatten_tolerance'),
    aciColor: smallint('aci_color').notNull().default(256),
    length: doublePrecision('length').generatedAlwaysAs(sql`ST_Length(geom)`),
    vertexCount: integer('vertex_count').generatedAlwaysAs(sql`ST_NPoints(geom)`),
  },
  (table) => [
    foreignKey({
      name: 'cad_curves_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('cascade'),
    unique('cad_curves_file_handle_key').on(table.cadFileId, table.handle),
    index('cad_curves_file_layer_idx').on(table.cadFileId, table.layer),
  ],
);

// ---------------------------------------------------------------------------------------------
// Phase 1b (migration 0005): mapping, design revisions, stable features, text links, diff.
// The CAD worker writes features, design_features, text_links and revision_diff_items; the API
// reads them and only changes text-link reviews, box codes and the revision's workflow columns.
// `length_m` is generated: never insert or update it.
// ---------------------------------------------------------------------------------------------

/** Geometry in the revision CRS (WGS 84 / UTM, metres). Spatial work uses `sql` in repositories. */
const geometry = customType<{ data: string }>({ dataType: () => 'geometry' });
const geometryPoint = customType<{ data: string }>({ dataType: () => 'geometry(Point)' });

export const cadMappings = pgTable(
  'cad_mappings',
  {
    cadFileId: uuid('cad_file_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    rules: jsonb('rules').$type<MappingRule[]>().notNull(),
    crsEpsg: integer('crs_epsg').notNull(),
    drawingUnit: text('drawing_unit').$type<DrawingUnit>().notNull(),
    metresPerUnit: numeric('metres_per_unit', { precision: 12, scale: 6 }).notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'cad_mappings_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('cascade'),
  ],
);

export const designRevisions = pgTable(
  'design_revisions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    cadFileId: uuid('cad_file_id').notNull(),
    revNo: integer('rev_no'),
    status: text('status')
      .$type<'queued' | 'building' | 'draft' | 'failed' | 'published' | 'discarded'>()
      .notNull()
      .default('queued'),
    currentJobId: uuid('current_job_id').notNull(),
    baseRevisionId: uuid('base_revision_id'),
    rules: jsonb('rules').$type<MappingRule[]>().notNull(),
    mappingVersion: integer('mapping_version').notNull(),
    crsEpsg: integer('crs_epsg').notNull(),
    drawingUnit: text('drawing_unit').$type<DrawingUnit>().notNull(),
    metresPerUnit: numeric('metres_per_unit', { precision: 12, scale: 6 }).notNull(),
    insUnits: integer('ins_units'),
    unitsConflict: boolean('units_conflict').notNull().default(false),
    counts: jsonb('counts').$type<DesignRevisionCounts>(),
    textLinkCounts: jsonb('text_link_counts').$type<TextLinkCounts>(),
    diffCounts: jsonb('diff_counts').$type<DiffCounts>(),
    tilesStorageKey: text('tiles_storage_key'),
    warnings: jsonb('warnings').$type<CadWarning[]>().notNull().default([]),
    log: text('log'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    buildStartedAt: timestamp('build_started_at', { withTimezone: true }),
    builtAt: timestamp('built_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    unique('design_revisions_project_id_id_key').on(table.projectId, table.id),
    unique('design_revisions_rev_no_key').on(table.projectId, table.revNo),
    foreignKey({
      name: 'design_revisions_file_fkey',
      columns: [table.projectId, table.cadFileId],
      foreignColumns: [cadFiles.projectId, cadFiles.id],
    }).onDelete('restrict'),
    index('design_revisions_project_created_idx').on(table.projectId, table.createdAt),
  ],
);

export const features = pgTable(
  'features',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    featureType: text('feature_type').$type<FeatureType>().notNull(),
    firstRevisionId: uuid('first_revision_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('features_project_id_id_key').on(table.projectId, table.id)],
);

export const designFeatures = pgTable(
  'design_features',
  {
    revisionId: uuid('revision_id').notNull(),
    featureId: uuid('feature_id').notNull(),
    projectId: uuid('project_id').notNull(),
    featureType: text('feature_type').$type<FeatureType>().notNull(),
    code: text('code'),
    layer: text('layer').notNull(),
    blockName: text('block_name'),
    sourceKind: text('source_kind').$type<'curve' | 'insert' | 'text'>().notNull(),
    sourceHandle: text('source_handle').notNull(),
    geom: geometry('geom').notNull(),
    /** Generated: metres, routes only. Read-only. */
    lengthM: numeric('length_m', { precision: 14, scale: 3 }).generatedAlwaysAs(
      sql`CASE WHEN feature_type = 'route' THEN round(ST_Length(geom)::numeric, 3) END`,
    ),
    attrs: jsonb('attrs').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.featureId] }),
    index('design_features_revision_type_idx').on(table.revisionId, table.featureType),
  ],
);

export const textLinks = pgTable(
  'text_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    textHandle: text('text_handle').notNull(),
    layer: text('layer').notNull(),
    text: text('text'),
    rawText: text('raw_text').notNull(),
    readable: boolean('readable').notNull(),
    position: geometryPoint('position').notNull(),
    heightM: doublePrecision('height_m').notNull(),
    kind: text('kind').$type<TextLinkKind>().notNull(),
    status: text('status').$type<TextLinkStatus>().notNull(),
    featureId: uuid('feature_id'),
    distanceM: numeric('distance_m', { precision: 12, scale: 3 }),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    unique('text_links_handle_key').on(table.revisionId, table.textHandle),
    index('text_links_review_idx').on(
      table.revisionId,
      table.status,
      table.confidence,
      table.textHandle,
    ),
  ],
);

export const revisionDiffItems = pgTable(
  'revision_diff_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    featureId: uuid('feature_id').notNull(),
    featureType: text('feature_type').$type<FeatureType>().notNull(),
    change: text('change').$type<DiffChange>().notNull(),
    code: text('code'),
    previousCode: text('previous_code'),
    distanceM: numeric('distance_m', { precision: 14, scale: 3 }),
    lengthDeltaM: numeric('length_delta_m', { precision: 14, scale: 3 }),
    candidateFeatureIds: uuid('candidate_feature_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (table) => [
    unique('revision_diff_items_feature_key').on(table.revisionId, table.featureId),
    index('revision_diff_items_change_idx').on(table.revisionId, table.change),
  ],
);

// ---------------------------------------------------------------------------------------------
// Phase 2 (migration 0007, ADR-027). Triggers lock the BOQ of an approved contract and keep the
// currency immutable; `amount` is generated (never insert it).
// ---------------------------------------------------------------------------------------------

export const contracts = pgTable(
  'contracts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    number: text('number').notNull(),
    name: text('name').notNull(),
    client: text('client').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    startsOn: date('starts_on', { mode: 'string' }),
    durationDays: integer('duration_days'),
    notes: text('notes'),
    status: text('status').$type<'draft' | 'approved'>().notNull().default('draft'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('contracts_number_key').on(table.number)],
);

export const contractItems = pgTable(
  'contract_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    kind: text('kind').$type<'item' | 'heading'>().notNull(),
    code: text('code').notNull(),
    description: text('description'),
    unit: text('unit'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }),
    amount: numeric('amount', { precision: 38, scale: 10 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    workType: text('work_type').$type<'civil' | 'installation' | 'planning'>(),
    source: text('source').$type<'manual' | 'import'>().notNull().default('manual'),
    sourceRow: integer('source_row'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('contract_items_line_no_key').on(table.contractId, table.lineNo),
    index('contract_items_contract_code_idx').on(table.contractId, table.code),
  ],
);

export const contractAttachments = pgTable(
  'contract_attachments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'document' | 'import_source'>().notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('contract_attachments_contract_idx').on(table.contractId, table.createdAt)],
);

export const schema = {
  users,
  refreshTokens,
  projects,
  zones,
  assignments,
  events,
  workOrders,
  workOrderItems,
  workOrderAttachments,
  contracts,
  contractItems,
  contractAttachments,
  cadFiles,
  cadLayers,
  cadInserts,
  cadTexts,
  cadCurves,
  cadMappings,
  designRevisions,
  features,
  designFeatures,
  textLinks,
  revisionDiffItems,
};
