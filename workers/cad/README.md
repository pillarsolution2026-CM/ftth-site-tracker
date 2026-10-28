# CAD worker

Python worker for server-side CAD processing (ADR-002, ADR-013). Two job types on the same Redis
protocol:

- `cad.import` (Phase 1a): DWG/DXF import into raw extraction tables (SRID 0, drawing units), plus
  the CRS detection stored on `cad_files.crs_detection` (Phase 1b).
- `cad.build_revision` (Phase 1b, ADR-017..021): mapping rules -> design features, text links,
  diff against the base revision and a PMTiles archive; the revision ends `draft` (or `failed`).
  Every coordinate is scaled by the revision's `metres_per_unit` (ADR-018: no unit is assumed).

Layout:

- `cad_worker/domain`: pure logic (no I/O, no ezdxf): model, flattening, extents, warnings, text
  decoding (`shx_arabic.json` = the owner-confirmed lowercase Arabic 101 table, ADR-019),
  `crs_detect.py`, `design_build.py` (rules -> features), `text_links.py` (ADR-019),
  `revision_match.py` (ADR-020), `geo.py` = the only place for CRS transforms.
- `cad_worker/application`: use cases (`import_job`, `extract`, `build_revision`), consumer loop,
  ports.
- `cad_worker/adapters`: ezdxf reader, LibreDWG-WASM converter (Node subprocess), PostgreSQL
  (psycopg, COPY; `postgres_revision_repo.py` for revisions), `pmtiles_writer.py` (ST_AsMVT in the
  build transaction, z12-18, gzip), Redis broker (ADR-013), `fs`/`s3` storage, settings.
- `converter/`: `dwg2dxf.mjs` + pinned `@mlightcad/libredwg-web@0.8.2` (`npm ci --omit=dev`).

Settings (env): `DATABASE_URL`, `REDIS_URL`, `WORKER_ID` (default hostname), `STORAGE_DRIVER`
(`fs`|`s3`), `STORAGE_FS_ROOT`, `S3_ENDPOINT|BUCKET|ACCESS_KEY|SECRET_KEY|REGION`,
`CONVERTER_TIMEOUT_S`, `CONVERTER_MAX_OLD_SPACE_MB`.

```
(cd converter && npm ci --omit=dev)
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest --cov=cad_worker
uv run python -m cad_worker --health
uv run python -m cad_worker          # consumer loop
```

Tests need a real PostGIS and Redis: set `TEST_DATABASE_URL` / `TEST_REDIS_URL`, otherwise
docker is used (`postgis/postgis:16-3.4`, `redis:7.4-alpine`).

## Golden run (real drawings)

Golden tests on the client's drawings read `fixtures/cad/` (git-ignored; override with
`CAD_FIXTURES_DIR`) and are skipped when absent. One command runs them:

```
workers/cad/scripts/golden.sh                     # or CAD_FIXTURES_DIR=/path scripts/golden.sh
UPDATE_GOLDEN=1 workers/cad/scripts/golden.sh     # rewrite the committed counts
```

It checks that the directory has `.dwg`/`.dxf` files, installs the converter (`npm ci --omit=dev`)
when `converter/node_modules` is missing, runs `uv sync --frozen`, then
`uv run pytest tests/test_golden.py -v -s` (docker PostGIS unless `TEST_DATABASE_URL` is set).
It imports every drawing named in `tests/golden/*.json` and, for Qalyub sector 1, builds a design
revision with `tests/golden/qalyub_sector1_mapping.json`, printing routes, route metres, boxes,
HHI, joints, the suggested EPSG, the units conflict and the seconds (asserted: 17 boxes, 4 joints,
6 HHI, EPSG 32636, build < 60 s). That mapping uses the drawing unit `m` as a test parameter only,
not as a product default (ADR-018). Golden values that are `null` (route count/metres, and the
`unreadable_texts` counts made stale by the SHX table) are printed instead of compared until they
are regenerated with `UPDATE_GOLDEN=1`.
