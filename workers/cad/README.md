# CAD worker

Python worker for server-side CAD processing (ADR-002, ADR-013). Phase 1a: DWG/DXF import into raw
extraction tables (SRID 0, drawing units).

- `cad_worker/domain`: pure logic (no I/O, no ezdxf): model, flattening, extents, warnings, text
  decoding (`shx_arabic.json` = mapping table), `geo.py` = the only place for CRS transforms.
- `cad_worker/application`: use cases (`import_job`, `extract`), consumer loop, ports.
- `cad_worker/adapters`: ezdxf reader, LibreDWG-WASM converter (Node subprocess), PostgreSQL
  (psycopg, COPY), Redis broker (ADR-013), `fs`/`s3` storage, settings.
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
docker is used (`postgis/postgis:16-3.4`, `redis:7.4-alpine`). Golden tests on the real drawings
read `fixtures/cad/` (git-ignored; override with `CAD_FIXTURES_DIR`) and are skipped when absent;
regenerate the committed counts with `UPDATE_GOLDEN=1 uv run pytest tests/test_golden.py`.
