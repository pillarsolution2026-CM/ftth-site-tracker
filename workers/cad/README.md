# CAD worker

Python worker for server-side CAD processing (ADR-002). Phase 0: plumbing only.

- `cad_worker/domain`: pure logic; `geo.py` is the only place for CRS transforms.
- `cad_worker/application`: use cases and ports (`JobQueue`).
- `cad_worker/adapters`: settings, Redis queue (list `cad:jobs`, results at `cad:results:<job_id>`).

```
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest --cov=cad_worker
uv run python -m cad_worker --health
uv run python -m cad_worker          # consumer loop (REDIS_URL)
```
