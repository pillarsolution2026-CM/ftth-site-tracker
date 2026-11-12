"""Use case: process one `cad.build_revision` job end to end (ADR-017, Phase 1b contract).

queued -> building -> draft, or failed with a code. Everything the build writes (features, text
links, diff, counts, tiles key) is committed in ONE transaction guarded by the revision's
`current_job_id`; a superseded job writes nothing.
"""

from __future__ import annotations

import dataclasses
import logging
import tempfile
import time
import uuid
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Literal
from uuid import UUID

from cad_worker.adapters.job_message import CadBuildRevisionJob
from cad_worker.application.keys import revision_tiles_key
from cad_worker.application.ports import (
    BuildFailure,
    BuildSummary,
    DiffRow,
    FeatureRow,
    ObjectStorage,
    RevisionBuild,
    RevisionRepository,
    RevisionRows,
    TextLinkRow,
    TileLimitError,
)
from cad_worker.domain.box_reading import read_box_shapes
from cad_worker.domain.box_shapes import (
    BoxTypeOnBox,
    BoxTypesInvalidError,
    parse_frozen_box_types,
)
from cad_worker.domain.corrections import (
    CorrectionInvalidError,
    apply_corrections,
    curve_handles,
    parse_corrections,
)
from cad_worker.domain.design import (
    FEATURE_TYPES,
    DesignFeatureDraft,
    FeatureKey,
    metres3,
    polyline_length,
)
from cad_worker.domain.design_build import (
    BackgroundSelection,
    DrawingData,
    MappingInvalidError,
    MappingRules,
    build_features,
    parse_rules,
)
from cad_worker.domain.drawing_checks import check_drawing, problems_json
from cad_worker.domain.kind_checks import check_kind
from cad_worker.domain.placement import (
    PlacementInvalidError,
    Placer,
    make_placer,
    parse_placement,
)
from cad_worker.domain.revision_match import BaseFeature, diff_counts, match_revision
from cad_worker.domain.role_reading import READING_ATTR_KEY, read_drawing, reading_totals
from cad_worker.domain.text_links import (
    TextLinkDraft,
    box_codes,
    link_texts,
    linked_texts_by_kind,
    status_counts,
)
from cad_worker.domain.text_roles import DRAWING_KINDS, DrawingKind

log = logging.getLogger(__name__)

# Fixed texts for `design_revisions.error_message`, which every `design:read` user can see.
TILES_TOO_LARGE_MESSAGE = "Tile generation failed: the drawing covers too many tiles."
TILES_FAILED_MESSAGE = "Tile generation failed."
INTERNAL_MESSAGE = "Internal error while building the revision."

Outcome = Literal["built", "failed", "superseded"]


@dataclass(frozen=True, slots=True)
class BuildDeps:
    repo: RevisionRepository
    storage: ObjectStorage
    tmp_root: Path | None = None
    new_id: Callable[[], UUID] = field(default=uuid.uuid4)


@dataclass(frozen=True, slots=True)
class DesignBuild:
    """Pure result of a build, before it is written."""

    rows: RevisionRows
    background: BackgroundSelection
    feature_counts: dict[str, int]
    text_link_counts: dict[str, int]
    diff_counts: dict[str, int]
    zero_length_routes: int
    # Totals per type / kind / role / status (ADR-033/034) and drawing problems (shared schemas).
    groups: list[dict[str, object]] = field(default_factory=list)
    problems: list[dict[str, object]] = field(default_factory=list)
    # ADR-041 `counts.reading` (roles reading mode only) and a log line about the reading.
    reading_totals: dict[str, object] | None = None
    reading_log: str | None = None
    # ADR-043 gallery of a roles-mode Secondary (`design_revisions.box_shapes`), else None.
    box_shapes: dict[str, object] | None = None


def run_build(job: CadBuildRevisionJob, deps: BuildDeps, worker_id: str) -> Outcome:
    """Never raises for handled failures; infrastructure errors (database down) propagate so the
    job stays in the in-flight list and is redelivered after a restart."""
    if not deps.repo.start_build(job, worker_id):
        log.info("build job %s superseded before start; dropped", job.id)
        return "superseded"
    started = time.monotonic()
    try:
        outcome = _build(job, deps, started)
    except BuildFailure as failure:
        return _fail(deps, job, failure)
    except Exception as exc:
        log.exception("build job %s crashed", job.id)
        detail = f"{type(exc).__name__}: {exc}"
        return _fail(deps, job, BuildFailure("INTERNAL", INTERNAL_MESSAGE, detail))
    log.info("build job %s %s in %.1fs", job.id, outcome, time.monotonic() - started)
    return outcome


def _fail(deps: BuildDeps, job: CadBuildRevisionJob, failure: BuildFailure) -> Outcome:
    recorded = deps.repo.fail(job, failure.code, failure.message, failure.log)
    log.warning("build job %s failed: %s %s", job.id, failure.code, failure.message)
    return "failed" if recorded else "superseded"


def _build(job: CadBuildRevisionJob, deps: BuildDeps, started: float) -> Outcome:
    with deps.repo.open_build(job) as tx:
        if tx is None:
            return "superseded"
        inputs = tx.inputs
        try:
            rules = parse_rules(inputs.rules)
            place = make_placer(
                parse_placement(inputs.placement),
                inputs.crs_epsg,
                float(inputs.metres_per_unit),  # geometry only; the exact factor stays stored
            )
            corrections = parse_corrections(inputs.corrections)
            box_types = parse_frozen_box_types(inputs.box_types)
        except (
            MappingInvalidError,
            PlacementInvalidError,
            CorrectionInvalidError,
            BoxTypesInvalidError,
        ) as exc:
            raise BuildFailure("MAPPING_INVALID", str(exc)) from exc
        kind = inputs.drawing_kind
        if kind not in DRAWING_KINDS:
            raise BuildFailure("MAPPING_INVALID", f"unknown drawing kind {kind!r}")
        # Route layers for routes; point layers for their closed shapes (ADR-033); zone layers
        # (ADR-041); curves named by a correction wherever they are.
        drawing = tx.load_drawing(rules.curve_layers(), curve_handles(corrections))
        # Corrections made on the program page (ADR-038), before classification and checks: every
        # feature, text link and problem sees the corrected drawing. The background tile layer is
        # rendered from the raw rows and does not show them.
        try:
            drawing = apply_corrections(
                drawing,
                corrections,
                metres_per_unit=place.unit_m,
                move_targets=rules.layers_with(*FEATURE_TYPES, "label"),
            )
        except CorrectionInvalidError as exc:
            raise BuildFailure("MAPPING_INVALID", str(exc)) from exc
        base = tx.load_base()
        previews = tx.load_shape_previews() if box_types_apply(kind, rules) else {}
        design = compose_design(
            drawing,
            rules,
            place,
            base,
            deps.new_id,
            kind,
            box_types=box_types,
            shape_previews=previews,
        )
        route_length = tx.write(design.rows)
        built_s = time.monotonic() - started
        key, tiles_log = _tiles(job, tx, deps, design.background)
        tx.finish(
            _summary(
                inputs.drawing_unit,
                inputs.metres_per_unit,
                design,
                route_length,
                key,
                [
                    f"corrections: {len(corrections)} applied",
                    *([f"reading: {design.reading_log}"] if design.reading_log else []),
                    f"build: {built_s:.1f}s",
                    tiles_log,
                    f"total: {time.monotonic() - started:.1f}s",
                ],
            )
        )
    return "built"


def box_types_apply(drawing_kind: str, rules: MappingRules) -> bool:
    """Box types are a Secondary reading by roles (`boxTypesApply`, ADR-043)."""
    return drawing_kind == "secondary" and rules.reading_mode == "roles"


def compose_design(
    drawing: DrawingData,
    rules: MappingRules,
    place: Placer,
    base: Sequence[BaseFeature],
    new_id: Callable[[], UUID],
    drawing_kind: DrawingKind = "general",
    *,
    box_types: Mapping[str, BoxTypeOnBox] | None = None,
    shape_previews: Mapping[str, Mapping[str, object]] | None = None,
) -> DesignBuild:
    """Rules -> features -> text links -> box codes -> match against the base. Pure.

    In `roles` reading mode (ADR-041) the role texts are read by meaning: feature codes come
    from them (box "cabinet/number", handhole number, cabinet name), each box / route / hhi /
    cabinet keeps its reading in `attrs.reading`, the drawing kind's checks run and the totals
    go to `counts.reading`. `legacy` mode is exactly Phase 1."""
    built = build_features(drawing, rules, place)
    links = link_texts(built.link_texts, built.features)
    linked = linked_texts_by_kind(links)
    reading = None
    if rules.reading_mode == "roles":
        reading = read_drawing(
            built.features,
            drawing.texts,
            drawing.curves,
            rules,
            place,
            drawing_kind,
            built.text_feature_handles,
        )
        codes = {k: c for k, c in reading.codes.items() if c is not None}
        features = [
            _with_links(f, codes.get(f.key), linked.get(f.key), reading.readings.get(f.key))
            for f in built.features
        ]
    else:
        codes = box_codes(links, built.features)
        features = [_with_links(f, codes.get(f.key), linked.get(f.key)) for f in built.features]
    gallery = None
    if box_types_apply(drawing_kind, rules):
        shapes = read_box_shapes(features, drawing, shape_previews or {}, box_types or {})
        features, gallery = shapes.features, shapes.gallery
    match = match_revision(features, base, new_id)
    types = {fid: f.feature_type for f in features if (fid := match.ids[f.key]) in match.new_ids}
    rows = RevisionRows(
        new_feature_ids=tuple(sorted(((fid, t) for fid, t in types.items()), key=str)),
        features=tuple(_feature_row(f, match.ids[f.key]) for f in features),
        text_links=tuple(_link_row(link, match.ids) for link in links),
        diff=tuple(
            DiffRow(
                e.feature_id,
                e.feature_type,
                e.change,
                e.code,
                e.previous_code,
                e.distance_m,
                e.candidate_ids,
            )
            for e in match.entries
        ),
    )
    by_type = Counter(f.feature_type for f in features)
    found, names = check_drawing(features, drawing.texts, rules, place)
    totals = None
    reading_log = None
    if reading is not None:
        phase1_missing = frozenset(i.handle for i in found["LABEL_MISSING"])
        for code, items in check_kind(features, reading, rules, phase1_missing).items():
            found[code].extend(items)
        totals = reading_totals(reading, features)
        reading_log = (
            f"roles ({drawing_kind}), {len(reading.texts)} role texts read, "
            f"{len(reading.text_feature)} linked, {reading.unread_texts} unread"
        )
    return DesignBuild(
        rows=rows,
        background=built.background,
        feature_counts={t: by_type.get(t, 0) for t in FEATURE_TYPES},
        text_link_counts=status_counts(links),
        diff_counts=diff_counts(match.entries),
        zero_length_routes=built.zero_length_routes,
        groups=feature_groups(features),
        problems=problems_json(found, features, names, place),
        reading_totals=totals,
        reading_log=reading_log,
        box_shapes=gallery,
    )


def feature_groups(features: Sequence[DesignFeatureDraft]) -> list[dict[str, object]]:
    """`counts.groups`: one row per type / kind / role / status, routes with their drawn length."""
    GroupKey = tuple[str, str | None, str | None, str]
    counts: Counter[GroupKey] = Counter()
    lengths: dict[GroupKey, float] = {}
    for f in features:
        kind, role = f.attrs.get("kind"), f.attrs.get("role")
        group: GroupKey = (
            f.feature_type,
            str(kind) if kind is not None else None,
            str(role) if role is not None else None,
            str(f.attrs.get("status", "new")),
        )
        counts[group] += 1
        if f.is_route:
            lengths[group] = lengths.get(group, 0.0) + polyline_length(f.coords)
    order: dict[str, int] = {t: i for i, t in enumerate(FEATURE_TYPES)}
    rows: list[dict[str, object]] = []
    for key in sorted(counts, key=lambda k: (order[k[0]], k[1] or "", k[2] or "", k[3])):
        feature_type, group_kind, group_role, status = key
        length = lengths.get(key)
        rows.append(
            {
                "type": feature_type,
                "kind": group_kind,
                "role": group_role,
                "status": status,
                "count": counts[key],
                "lengthM": None if length is None else f"{metres3(length):.3f}",
            }
        )
    return rows


def _with_links(
    feature: DesignFeatureDraft,
    code: str | None,
    texts: dict[str, list[str]] | None,
    reading: dict[str, object] | None = None,
) -> DesignFeatureDraft:
    attrs = {**feature.attrs, "texts": texts} if texts else dict(feature.attrs)
    if reading is not None:
        attrs[READING_ATTR_KEY] = reading
    return dataclasses.replace(feature, code=code, attrs=attrs)


def _feature_row(feature: DesignFeatureDraft, feature_id: UUID) -> FeatureRow:
    return FeatureRow(
        feature_id=feature_id,
        feature_type=feature.feature_type,
        code=feature.code,
        layer=feature.layer,
        block_name=feature.block_name,
        source_kind=feature.source_kind,
        source_handle=feature.source_handle,
        coords=feature.coords,
        attrs=dict(feature.attrs),
    )


def _link_row(link: TextLinkDraft, ids: dict[FeatureKey, UUID]) -> TextLinkRow:
    t = link.text
    return TextLinkRow(
        text_handle=t.handle,
        layer=t.layer,
        text=t.text,
        raw_text=t.raw_text,
        readable=t.readable,
        position=t.position,
        height_m=t.height_m,
        kind=link.kind,
        status=link.status,
        feature_id=ids[link.feature] if link.feature is not None else None,
        distance_m=link.distance_m,
        confidence=link.confidence,
    )


def _tiles(
    job: CadBuildRevisionJob, tx: RevisionBuild, deps: BuildDeps, background: BackgroundSelection
) -> tuple[str | None, str]:
    """Render inside the open transaction and upload before commit; any error = TILES_FAILED."""
    started = time.monotonic()
    key = revision_tiles_key(job.project_id, job.revision_id)
    try:
        with tempfile.TemporaryDirectory(prefix="tiles-", dir=deps.tmp_root) as tmp_name:
            path = Path(tmp_name) / "design.pmtiles"
            stats = tx.render_tiles(path, background)
            if stats.tiles == 0:
                return None, "tiles: none (nothing to draw)"
            deps.storage.upload(path, key)
    except TileLimitError as exc:
        raise BuildFailure("TILES_FAILED", TILES_TOO_LARGE_MESSAGE, f"tiles: {exc}") from exc
    except Exception as exc:
        # Readers see a fixed message; exception text (paths, SQL) goes to the log only (review L3).
        detail = f"tiles: {type(exc).__name__}: {exc}"
        raise BuildFailure("TILES_FAILED", TILES_FAILED_MESSAGE, detail) from exc
    took = time.monotonic() - started
    return key, f"tiles: {stats.tiles} tiles, {stats.bytes} bytes, {took:.1f}s"


def _summary(
    drawing_unit: str,
    metres_per_unit: Decimal,
    design: DesignBuild,
    route_length: Decimal,
    tiles_key: str | None,
    timings: list[str],
) -> BuildSummary:
    warnings: list[dict[str, object]] = []
    if design.zero_length_routes:
        warnings.append({"code": "ROUTE_ZERO_LENGTH_SKIPPED", "count": design.zero_length_routes})
    warnings.extend(design.problems)
    lines = [
        f"units: 1 {drawing_unit} = {metres_per_unit} m",
        "features: " + " ".join(f"{t}={n}" for t, n in design.feature_counts.items()),
        "problems: " + " ".join(f"{p['code']}={p['count']}" for p in design.problems),
        f"route length: {route_length:.3f} m (zero-length skipped: {design.zero_length_routes})",
        "text links: " + " ".join(f"{s}={n}" for s, n in design.text_link_counts.items()),
        "diff: " + " ".join(f"{c}={n}" for c, n in design.diff_counts.items()),
    ]
    if design.box_shapes is not None:
        g = design.box_shapes
        lines.append(
            f"box shapes: {g['shapeCount']} shapes, {g['boxCount']} boxes, "
            f"{g['boxesWithoutShape']} without a shape"
        )
    lines.extend(timings)
    counts: dict[str, object] = {
        "features": design.feature_counts,
        "routeLengthM": f"{route_length:.3f}",
        "groups": design.groups,
    }
    if design.reading_totals is not None:
        counts["reading"] = design.reading_totals
    return BuildSummary(
        counts=counts,
        text_link_counts=design.text_link_counts,
        diff_counts=design.diff_counts,
        tiles_storage_key=tiles_key,
        warnings=warnings,
        log="\n".join(lines),
        box_shapes=design.box_shapes,
    )
