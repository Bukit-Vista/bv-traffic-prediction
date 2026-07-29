# Development guide

Status: current engineering guidance. Last reviewed: 29 July 2026.

This guide keeps future work fast, reproducible, and safe as the traffic, mobility,
and places features evolve.

## 1. Local prerequisites

- Node.js 24 LTS (see [`.nvmrc`](../.nvmrc));
- npm from the Node.js distribution;
- a read-only MySQL account for connected development;
- Git;
- optional Playwright browser dependencies for end-to-end tests.

Install exactly what is recorded in the lockfile:

```bash
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Use `.env.local` for developer-specific values. Never commit `.env`, `.env.local`,
database passwords, operations tokens, write credentials, or provider credentials.

## 2. Runtime boundaries

The architecture deliberately separates responsibilities:

```text
Browser
  |
  +--> React/MapLibre UI
          |
          v
Next.js SSR and route handlers
  |          |
  |          +--> Redis JSON/GeoJSON/dashboard/vector-tile cache
  v
SELECT-only MySQL serving tables/views

Separate collectors and model workers --> database writes
```

Rules:

1. Web requests do not call external data providers.
2. The web MySQL account is SELECT-only.
3. Collector/model writes use separate projects and credentials.
4. Missing data stays missing; UI code does not fabricate routes, flows, or counts.
5. Provider/database implementation details are not exposed in user-facing copy.
6. Stored timestamps are UTC; display timestamps are WITA (`Asia/Makassar`).

## 3. Development modes

### Connected mode (recommended)

Use a read-only staging database and production-like feature flags. This catches
schema/view drift and exercises real spatial query behavior.

```dotenv
DASHBOARD_DEMO_MODE=false
MYSQL_HOST=...
MYSQL_USER=..._reader
MYSQL_DATABASE=...
REDIS_URL=redis://...
REDIS_CACHE_ENABLED=true
REDIS_TRAFFIC_CACHE_MODE=prefer
```

### UI-only mode

Use only for isolated component work when a connected database is unavailable.
Production rejects demo mode. A UI-only session is not acceptable evidence for a
data/API release.

## 4. Fast feedback loop

During implementation:

```bash
npm run dev
npx tsc --noEmit --watch
npx vitest --watch
```

Before handing off:

```bash
npx tsc --noEmit
npm run test:unit
npm run build
```

Before production:

```bash
npm run test:integration
npm run test:browser
npm run release:gate
npm run release:gate:mvp
```

Integration tests that require MySQL must run against an isolated or read-only
staging schema:

```bash
RUN_MYSQL_CONTRACT_TESTS=1 npm run test:integration
```

## 5. Change workflow

For every change:

1. Identify the serving contract and feature flag.
2. Add or update the smallest relevant unit test first.
3. Implement server/data transformations before UI formatting.
4. Keep MapLibre source/layer changes imperative and narrowly scoped.
5. Verify loading, empty, stale, partial, and failure states.
6. Run TypeScript, unit tests, and the production build.
7. For API/schema changes, run integration and release-gate checks.
8. Record operational changes in this guide or the cloud runbook.

Avoid mixing unrelated visual, data-contract, and infrastructure changes in one
release. Smaller releases are easier to validate and roll back.

## 6. Repository ownership map

| Area | Primary files |
| --- | --- |
| Dashboard and navigation | `components/dashboard/DashboardShell.tsx` |
| Predicted Mobility MVP | `components/dashboard/InternalCatchmentPreview.tsx` |
| Main interactive map | `components/dashboard/BaliMobilityMap.tsx` |
| Traffic snapshot and tiles | `lib/snapshot/**`, `scripts/build-traffic-snapshot.ts` |
| Read APIs | `app/api/**`, `lib/api/**` |
| Database pool/policy | `lib/db/mysql.ts` |
| Map transformations | `lib/map/**` |
| Mobility model | `lib/mobility/**`, `config/mobility-model.gravity-v1.json` |
| Versioned SQL | `database/migrations/**` |
| Unit/integration/e2e tests | `tests/**` |
| Deployment | `deploy/**`, `docs/cloud-deployment-runbook.md` |

When a file becomes hard to review, extract pure transformations into `lib/**` and
test them independently instead of growing dashboard components further.

## 7. API and database evolution

The web app reads versioned serving views. Database changes follow this sequence:

1. Add a new backward-compatible view/version through the database-owned migration
   process.
2. Add integration tests for row shape, nullability, identifiers, and semantics.
3. Deploy the view before the application.
4. Release application support with fallback allowed where explicitly documented.
5. Observe staging and production.
6. Enable the corresponding `*_VIEWS_REQUIRED` flag.
7. Remove the fallback in a later release.

Never run repository migrations with the SELECT-only application account. Never
rename or remove a serving column in the same release that introduces its
replacement.

For spatial data:

- store and serve WGS84/SRID 4326;
- validate bounds and geometry type;
- use numeric bounding-box predicates and bounded limits;
- never replace missing road geometry with straight centroid lines.

## 8. Caching strategy

The stack has four cache layers:

1. Redis-backed JSON, GeoJSON, dashboard, and immutable vector-tile values.
2. API conditional responses and ETags.
3. Browser/client JSON cache.
4. Browser and MapLibre tile cache.

All server cache values must use the Redis helpers instead of one-off module maps.
Cache keys
must include every parameter that changes the result: slot, bbox, zoom, metric,
category, and source version.

Normal latest-mode updates are automatic: the browser polls the version endpoint
and fetches only changed resources. An explicit maintenance refresh must evict
only the exact affected cache key before fetching. A failed automatic or explicit
refresh must leave the previous valid data visible.

Do not cache mutable API errors. Immutable tile URLs must include the snapshot
version.

## 9. Map performance rules

Map rendering is the most sensitive client workload:

- prefer vector tiles for province-wide traffic;
- keep GeoJSON queries bounded (`limit <= 5000`);
- use stable source objects and update only changed sources;
- schedule selection/source updates on animation frames;
- avoid backdrop blur over continuously animated maps;
- keep OD animation near 20–24 FPS rather than forcing 60 FPS;
- do not rebuild MapLibre when React selection state changes;
- defer expensive places/grid work until the map is idle;
- display only the accepted stored grid boundaries;
- preserve click hit layers separately from visible thin lines;
- test fullscreen and a 1366×768 viewport.

When adding a layer, document:

- source and semantic meaning;
- maximum feature count;
- minimum/maximum zoom;
- ordering relative to traffic and OD layers;
- click behavior;
- reduced-motion behavior;
- loading and empty state.

## 10. Places grid

The database build stores approximately `0.01°` cells. The UI displays those stored
cells directly, including their stored attraction and density indices. It must not
subdivide, interpolate, or recalculate cells inside the web request because that
would imply precision beyond the accepted aggregation.

Keep these safeguards:

- use the accepted display-grid build and its original cell boundaries;
- maximum 5,000 returned cells;
- exact category filter;
- explicit `truncated` metadata;
- lower extrusion heights for readability;
- no visual subdivision or viewport-relative normalization.

Change grid resolution only in the versioned ingestion/build pipeline, with a new
grid version and validation, rather than inside the API or browser.

## 11. Feature flags

Flags are deployment controls, not authorization:

- `BALI_SOURCE_DASHBOARD_ENABLED`
- `AIRPORT_TOURISM_ROUTES_ENABLED`
- `MOBILITY_SHADOW_READ_ENABLED`
- `MOBILITY_SHADOW_UI_ENABLED`
- `MOBILITY_PLACES_LAYER_ENABLED`
- `MOBILITY_CATCHMENT_SHADOW_UI_ENABLED`
- `MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED`

Default new production features to off. Enable in staging, run the release gates,
observe at least one complete collection cycle, then promote.

The operations API token protects restricted collector history. It is independent
from MVP dashboard access.

## 12. Dependency and runtime policy

- Pin Node with `.nvmrc` and `package.json#engines`.
- Use `npm ci`, never regenerate the lockfile during deployment.
- Update dependencies in dedicated pull requests.
- After a Next.js, React, MapLibre, MySQL, or Redis client upgrade, run all test
  layers and exercise map fullscreen plus cached vector tiles.
- Review `npm audit` findings, but do not apply unreviewed forced major upgrades.

Cache `~/.npm` and `.next/cache` in CI using `package-lock.json` as part of the key.

## 13. CI pipeline

Recommended jobs:

1. **Static**
   - `npm ci`
   - `npx tsc --noEmit`
2. **Unit**
   - `npm run test:unit`
3. **Build**
   - `npm run build`
4. **Integration (protected environment)**
   - read-only staging MySQL
   - `RUN_MYSQL_CONTRACT_TESTS=1 npm run test:integration`
5. **Browser**
   - install Playwright system dependencies in the CI image
   - `npm run test:browser`
6. **Release gate**
   - run against the target environment before promotion
7. **Deploy**
   - immutable release artifact
   - atomic symlink switch
   - smoke tests

Do not expose secrets to pull requests from untrusted forks.

## 14. Definition of done

A change is ready when:

- TypeScript passes;
- relevant unit tests exist and pass;
- production build passes;
- connected data changes pass integration tests;
- map changes work with reduced motion and fullscreen;
- empty, stale, partial, and error states remain usable;
- no secret/provider/database implementation detail appears in user-facing errors;
- deployment/config changes update the runbook and `.env.example`;
- rollback remains possible without a destructive database operation.
