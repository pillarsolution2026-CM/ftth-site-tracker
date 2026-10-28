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
from collections.abc import Callable, Sequence
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
)
from cad_worker.domain.design import FEATURE_TYPES, DesignFeatureDraft, FeatureKey
from cad_worker.domain.design_build import (
    BackgroundSelection,
    DrawingData,
    MappingInvalidError,
    MappingRules,
    build_features,
    parse_rules,
)
from cad_worker.domain.revision_match import BaseFeature, diff_counts, match_revision
from cad_worker.domain.text_links import (
    TextLinkDraft,
    box_codes,
    link_texts,
    linked_texts_by_kind,
    status_counts,
)

log = logging.getLogger(__name__)

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
        return _fail(deps, job, BuildFailure("INTERNAL", f"{type(exc).__name__}: {exc}"))
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
        except MappingInvalidError as exc:
            raise BuildFailure("MAPPING_INVALID", str(exc)) from exc
        drawing = tx.load_drawing(rules.layers_with("route"))
        base = tx.load_base()
        design = compose_design(drawing, rules, inputs.metres_per_unit, base, deps.new_id)
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
                [f"build: {built_s:.1f}s", tiles_log, f"total: {time.monotonic() - started:.1f}s"],
            )
        )
    return "built"


def compose_design(
    drawing: DrawingData,
    rules: MappingRules,
    metres_per_unit: Decimal,
    base: Sequence[BaseFeature],
    new_id: Callable[[], UUID],
) -> DesignBuild:
    """Rules -> features -> text links -> box codes -> match against the base. Pure."""
    built = build_features(drawing, rules, metres_per_unit)
    links = link_texts(built.link_texts, built.features)
    codes = box_codes(links, built.features)
    linked = linked_texts_by_kind(links)
    features = [_with_links(f, codes.get(f.key), linked.get(f.key)) for f in built.features]
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
    return DesignBuild(
        rows=rows,
        background=built.background,
        feature_counts={t: by_type.get(t, 0) for t in FEATURE_TYPES},
        text_link_counts=status_counts(links),
        diff_counts=diff_counts(match.entries),
        zero_length_routes=built.zero_length_routes,
    )


def _with_links(
    feature: DesignFeatureDraft, code: str | None, texts: dict[str, list[str]] | None
) -> DesignFeatureDraft:
    attrs = {**feature.attrs, "texts": texts} if texts else dict(feature.attrs)
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
    except Exception as exc:
        raise BuildFailure("TILES_FAILED", f"{type(exc).__name__}: {exc}") from exc
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
    lines = [
        f"units: 1 {drawing_unit} = {metres_per_unit} m",
        "features: " + " ".join(f"{t}={n}" for t, n in design.feature_counts.items()),
        f"route length: {route_length:.3f} m (zero-length skipped: {design.zero_length_routes})",
        "text links: " + " ".join(f"{s}={n}" for s, n in design.text_link_counts.items()),
        "diff: " + " ".join(f"{c}={n}" for c, n in design.diff_counts.items()),
        *timings,
    ]
    return BuildSummary(
        counts={"features": design.feature_counts, "routeLengthM": f"{route_length:.3f}"},
        text_link_counts=design.text_link_counts,
        diff_counts=design.diff_counts,
        tiles_storage_key=tiles_key,
        warnings=warnings,
        log="\n".join(lines),
    )
