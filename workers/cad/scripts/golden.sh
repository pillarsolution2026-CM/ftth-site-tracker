#!/usr/bin/env bash
# Golden run on the client's real drawings (git-ignored): imports every drawing named in
# tests/golden/*.json and, for Qalyub sector 1, builds a design revision with
# tests/golden/qalyub_sector1_mapping.json, printing the acceptance numbers (routes, route
# metres, boxes, HHI, joints, suggested EPSG, units conflict, seconds).
#
#   workers/cad/scripts/golden.sh                    # drawings in <repo>/fixtures/cad
#   CAD_FIXTURES_DIR=/path/to/drawings workers/cad/scripts/golden.sh
#   UPDATE_GOLDEN=1 workers/cad/scripts/golden.sh    # rewrite the committed golden counts
#
# PostGIS/Redis: TEST_DATABASE_URL (and TEST_REDIS_URL) when set, otherwise the tests start
# throw-away docker containers (postgis/postgis:16-3.4). Extra arguments go to pytest.
set -euo pipefail

worker_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${worker_dir}/../.." && pwd)"
fixtures="${CAD_FIXTURES_DIR:-${repo_root}/fixtures/cad}"

if [[ ! -d "${fixtures}" ]]; then
  echo "golden: drawings directory not found: ${fixtures} (set CAD_FIXTURES_DIR)" >&2
  exit 1
fi
shopt -s nullglob nocaseglob
drawings=("${fixtures}"/*.dwg "${fixtures}"/*.dxf)
shopt -u nullglob nocaseglob
if [[ ${#drawings[@]} -eq 0 ]]; then
  echo "golden: no .dwg/.dxf drawings in ${fixtures}" >&2
  exit 1
fi
echo "golden: ${#drawings[@]} drawing(s) in ${fixtures}"
export CAD_FIXTURES_DIR="${fixtures}"

cd "${worker_dir}"
if [[ ! -d converter/node_modules ]]; then
  echo "golden: installing the DWG converter (npm ci --omit=dev)"
  (cd converter && npm ci --omit=dev)
fi
uv sync --frozen

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "golden: set TEST_DATABASE_URL or install docker (PostGIS is never mocked)" >&2
    exit 1
  fi
  echo "golden: TEST_DATABASE_URL not set; using a throw-away docker PostGIS"
fi

exec uv run pytest tests/test_golden.py -v -s "$@"
