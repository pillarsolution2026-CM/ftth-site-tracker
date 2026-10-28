# `@ftth/geo` — design decisions

Package-local decisions. Anything that becomes cross-module should be promoted to `docs/DECISIONS.md`.

## G-1: Pure TypeScript, project CRS in metres
Every function works on `{ x, y }` in the project CRS (metric UTM). Lengths are planar (`Math.hypot` per segment), the same as PostGIS `ST_Length` on the stored geometry. `tsconfig` sets `lib: ["ES2022"]` and `types: []`, so DOM or Node APIs fail to compile. The only runtime dependency is `proj4`.

## G-2: Snap
- Targets: route endpoints, interior route vertices and symbols. The nearest one within the tolerance wins, and the tolerance boundary counts as inside.
- **Tie order (not specified by the plan, needs owner confirmation):** endpoint, then symbol, then vertex. The reasoning is that a route usually connects to another route's end or to a box.
- Tolerance is configurable per call, in metres. `SNAP_TOLERANCE_PX = 14` comes from the plan («هامش 14px»), and `toleranceFromPixels(px, metresPerPixel)` converts it at the current zoom.
- The feature or vertex being dragged is excluded, so it never snaps to itself. Other vertices of the same route can still be snapped to.

## G-3: Edits are data; history keeps snapshots
- `EditOperation` (`moveVertex`, `insertVertex`, `removeVertex`, `translate`) is plain data. `applyEdit` is pure and deterministic. A session's `appliedOperations` are what the device sends (with `client_op_id`) to become As-Built events.
- Undo restores the stored *before* route by reference, not by applying an inverse operation. This makes undo exact, with no float drift. Redo re-applies the same operation to the same input, so it gives an identical route.
- A route never has fewer than 2 vertices. Invalid operations throw `GeometryError` and leave the session unchanged.

## G-4: Arc / bulge flattening mirrors the CAD worker
`flatten.ts` is a port of `workers/cad/cad_worker/domain/flatten.py`, with the same centre formula, `FLATTEN_TOLERANCE_M = 0.001` (maximum sagitta) and `MAX_ARC_SEGMENTS = 2048`. A route flattened on a device therefore has the same vertices as the one the worker imported. Flattened lengths fall slightly short of the true arc length, by about `|sweep| · tolerance / 3` per arc (≈ 1 mm on a half circle). `bulgePolylineLength` gives the exact length when it is needed. If either implementation changes, change both.

## G-5: CRS
- This is the only TypeScript module that changes coordinates between CRSs (ARCHITECTURE §4). The Python counterpart is `cad_worker/domain/geo.py`.
- Supported: WGS 84 / UTM, EPSG 32601–32660 (north) and 32701–32760 (south), built as proj4 strings. No EPSG database is bundled. Any other EPSG code is rejected with `UNSUPPORTED_CRS` until a project needs it.
- Tests compare against pyproj 3.8 reference values to the millimetre, and a property test checks the round trip within 1 mm.
- proj4 returns a wrong point, without any error, for impossible WGS84 input such as lat 1e10 or lon 213. That can happen with a GPS glitch, so `fromWgs84` rejects |lon| > 180 or |lat| > 90 with `COORDINATE_OUT_OF_RANGE`. Non-finite results throw `NON_FINITE_COORDINATE`.

## G-6: Errors
`GeometryError` carries a typed `code`. These codes are internal to geometry. The API maps them to `VALIDATION_FAILED` when it exposes them, so `packages/shared` error codes are not changed here.

## G-7: Tests
- Every property runs 10,000 times with fast-check: lengths, edits, undo/redo, snap, segment distance, arc flattening and the CRS round trip.
- The arc flattening property checks the implementation against an independently derived arc centre.
- Coverage threshold is 90%; current coverage is 100%.
- `testTimeout` is 60 s because the arc property takes about 3 s alone and overran the 5 s default under turbo's parallel `pnpm test`.
