# Application Architecture and Feature Guide

Status: current canonical runtime documentation. Last reviewed: 29 July 2026.

## 1. Purpose

Atlas · Bali Traffic Intelligence is a read-only geospatial intelligence
application for viewing Bali traffic conditions, airport-route performance,
collector health, and model-derived tourism mobility.

The application does not collect HERE data and does not write analytical data
to MySQL. External automation owns collection and model writes. This
application validates, reads, caches, presents, and exports the resulting data.

All source timestamps are stored and served in UTC. The interface converts them
to WITA (`Asia/Makassar`, UTC+8) for display.

## 2. Application archetype

The application is best described as:

> A Dockerized, read-only geospatial dashboard implemented as a modular
> monolith and backend-for-frontend, with a separately running snapshot worker,
> a MySQL read model, and Redis materialized caches.

The terms describe different aspects of the application:

| Aspect | Classification |
| --- | --- |
| Product archetype | Operational and analytical geospatial dashboard |
| Server architecture | Modular monolith and backend-for-frontend (BFF) |
| UI architecture | Server-rendered Next.js page with an interactive React client |
| Background processing | Independently running snapshot and cache-prewarming worker |
| Data architecture | External write pipeline plus SELECT-only application read model |
| Cache architecture | Cache-aside JSON values plus immutable materialized snapshots |
| Programming paradigm | Primarily functional and modular TypeScript |
| Deployment architecture | Separate web and worker containers sharing MySQL and Redis |

It is not a microservices system. The web API and UI share one codebase and one
domain model. The worker is a separate process role so it can run and restart
independently, but it uses the same application modules.

## 3. How the code is written

### 3.1 Primary programming style

Most application logic is written using:

- TypeScript modules with explicit imports and exports;
- small functions for querying, validation, mapping, calculation, and caching;
- pure functions for mobility, congestion, viewport, and presentation
  calculations;
- React function components and hooks for interactive state;
- typed data contracts for API metadata, GeoJSON, routes, collection runs, and
  mobility resources;
- dependency parameters for testing selected database and cache operations;
- async functions for I/O and worker orchestration.

This is functional/modular code, not traditional class-oriented OOP.

Classes are used only where they provide a clear benefit:

- custom API error types;
- an HTTP response error;
- an internal minimum-priority queue.

The code does not use large inheritance trees, domain entity classes, active
records, or service objects with mutable application state.

### 3.2 React style

The browser UI uses declarative React:

- state is held with hooks such as `useState`, `useRef`, and `useMemo`;
- effects perform polling, browser lifecycle handling, and data requests;
- server data is supplied as the first render;
- MapLibre owns map rendering while React owns controls and selected state;
- query-string state preserves the selected view, slot, viewport, confidence,
  and route.

### 3.3 Module boundaries

| Directory | Responsibility |
| --- | --- |
| `app/` | Next.js pages and HTTP route handlers |
| `components/` | React dashboard, maps, cards, charts, and controls |
| `lib/api/` | API orchestration, validation, access control, and source contracts |
| `lib/db/` | SELECT-only MySQL connection and row mapping |
| `lib/cache/` | Compressed Redis JSON cache |
| `lib/snapshot/` | Traffic snapshots, vector tiles, refresh scheduling, and prewarming |
| `lib/map/` | Map calculations, styling decisions, OD animation, and viewports |
| `lib/mobility/` | Model and gravity calculations |
| `lib/dashboard/` | Shared dashboard data contracts and refresh planning |
| `lib/ui/` | Browser request caching and safe public error messages |
| `scripts/` | Maintenance, validation, import, release-gate, and worker entrypoints |
| `tests/` | Unit, integration, and browser tests |
| `docs/` | Contracts, runbooks, handoffs, and architecture documentation |

## 4. System context

```text
┌───────────────────────────────────────────────────────────────────┐
│ External data-production boundary                                 │
│                                                                   │
│ HERE APIs → n8n/collectors → traffic and route tables             │
│                         └→ mobility/model pipeline and views      │
└───────────────────────────────┬───────────────────────────────────┘
                                │ writes
                                ▼
                    ┌────────────────────────┐
                    │ MySQL / Amazon RDS     │
                    │ analytical read model  │
                    └───────────┬────────────┘
                                │ SELECT only
                   ┌────────────┴────────────┐
                   ▼                         ▼
        ┌────────────────────┐    ┌────────────────────────┐
        │ Snapshot worker    │    │ Next.js web and API    │
        │ every :12 and :42  │    │ BFF + server rendering │
        └──────────┬─────────┘    └────────────┬───────────┘
                   │                           │
                   ▼                           │
        ┌────────────────────┐                 │
        │ Redis/ElastiCache  │◄────────────────┘
        │ JSON, snapshots,   │
        │ manifests, tiles   │
        └──────────┬─────────┘
                   │
                   ▼
        ┌──────────────────────────────┐
        │ Browser dashboard            │
        │ React + MapLibre + Recharts  │
        │ polls version every 30 sec   │
        └──────────────────────────────┘
```

OpenStreetMap-derived tiles provide cartographic context only. HERE-derived
road measurements, route conditions, and model results are separate data
layers.

## 5. Runtime components

### 5.1 Web

The web container runs the Next.js standalone server on port 3000. It provides:

- the server-rendered dashboard;
- versioned `/api/v1` HTTP endpoints;
- internal feature-gated catchment-preview endpoints;
- independently gated public gravity-here-v2 catchment endpoints;
- traffic vector-tile delivery;
- CSV and GeoJSON exports;
- source validation, CORS, feature gates, rate limiting, and operations access.

The web process can read both Redis and MySQL. MySQL access is restricted to a
SELECT-only account, and production startup rejects an account with mutation
privileges.

### 5.2 Snapshot worker

The worker is a long-running Node.js process. By default it:

1. runs immediately after startup;
2. reads the latest valid dashboard state from MySQL;
3. validates the source contract;
4. creates compressed dashboard data and vector tiles;
5. writes versioned values to Redis;
6. publishes the current-version pointer last;
7. prewarms enabled catchment caches;
8. waits for the next aligned schedule.

The default schedule is every 30 minutes with a 12-minute offset, producing
runs at `:12` and `:42`. The offset allows the upstream collector and model
pipeline time to finish their writes.

If a refresh fails, the worker logs structured JSON and retries after one
minute. Builds do not overlap within one worker process.

### 5.3 One-shot snapshot builder

The maintenance-profile builder performs one snapshot build and exits. It is
useful for:

- initial cache creation;
- deployment verification;
- manually rebuilding after a source correction;
- automation workflows that want explicit control over publication.

### 5.4 MySQL / RDS

MySQL is the system of record for this application. It contains:

- HERE Flow collection runs and observations;
- road-segment geometry;
- route definitions, samples, and ordered geometry;
- versioned serving views;
- collector alert state;
- mobility model runs, zones, directional flows, and centers.

External automation owns writes. The dashboard never updates source tables and
does not use MySQL as an application cache.

### 5.5 Redis / ElastiCache

Redis holds rebuildable serving data:

- compressed JSON API cache entries;
- the current traffic-snapshot pointer;
- compressed dashboard snapshots;
- immutable versioned traffic vector tiles;
- prewarmed mobility resources.

Redis is not the authoritative data store. Losing Redis may reduce performance
or temporarily make required-cache deployments unavailable, but the data can be
rebuilt from MySQL.

## 6. Main features

### 6.1 Live traffic

The Live Traffic view provides:

- measured HERE road-segment conditions;
- road geometry rendered with MapLibre;
- jam-factor heatmap and directional pulse visualization;
- viewport-dependent traffic summary;
- confidence filtering;
- latest and exact-slot historical modes;
- selected road-segment history;
- measured coverage, closures, and congestion status.

Map pan, zoom, and confidence changes use precomputed traffic tiles and client
filtering where possible. They do not trigger a new spatial MySQL query for
every map interaction.

### 6.2 Predicted mobility

The Predicted Mobility view provides feature-gated model output:

- modeled tourism catchments;
- relative mobility/presence scores;
- directional origin-destination flows;
- tourism and airport catchment summaries;
- airport congestion pressure;
- source-derived places context;
- a 3D places display grid;
- model identity, coverage, status, and confidence.

Mobility values are relative model outputs. They are not actual counts of
people, vehicles, visits, or trips.

The internal preview and public v2 serving modes use the same immutable
22-polygon/21-model-zone/420-directed-pair data contract but independent
application flags. Public mode additionally requires database public-serving
readiness, an active v2 model, at least 0.90 input coverage, and no run error.
All related resources must resolve to the same model run before serving.
Legacy nine-area code remains a separate rollback path.

### 6.3 Route performance

The Route Performance view provides:

- active DPS Airport tourism corridors;
- independent inbound and outbound route directions;
- current, typical, and base duration comparisons;
- delay and duration ratios;
- ordered HERE route geometry;
- 12-hour history and coverage;
- route condition styling and selection.

The application never copies a measurement from the opposite route direction
when one direction is missing.

### 6.4 Data health

The Data Health view provides:

- latest Flow and Route collection states;
- successful, partial, running, failed, stale, and stuck states;
- coverage and record counts;
- slot age and retry information;
- the current completed-hour window;
- restricted detailed operations history.

Public responses do not expose raw provider payloads, credentials, or detailed
collector errors.

### 6.5 Historical data

Historical mode selects an exact `collection_slot_utc`. It does not silently
substitute another hour. Historical responses are suitable for longer Redis
TTLs because their source slot is immutable.

### 6.6 Exports

The API supports exports for:

- Flow as CSV;
- Flow as GeoJSON;
- routes as CSV;
- mobility flows as CSV;
- mobility zones as GeoJSON.

### 6.7 Feature-gated capabilities

Feature flags control source cutover, airport routes, mobility reads, places,
the internal catchment preview, and the public v2 rollout. The database
`public_serving_enabled` value is a readiness signal and never replaces the
public application flag.

Incidents and unsupported analytics return `FEATURE_NOT_READY` until their
production data gates pass. Production does not substitute fixtures when a
source is missing.

## 7. How automatic data updates work

Automatic updating has two independent parts.

### 7.1 Server-side refresh

```text
Upstream collection/model write finishes
                  │
                  ▼
Worker reaches :12 or :42
                  │
                  ▼
Read and validate latest MySQL state
                  │
                  ▼
Build compressed dashboard + vector tiles
                  │
                  ▼
Write all versioned Redis values
                  │
                  ▼
Publish current pointer atomically
```

The pointer is written last. Readers therefore see either the previous complete
snapshot or the new complete snapshot, never a partially written layer.

### 7.2 Browser-side refresh

In latest mode, the browser:

1. requests `/api/v1/dashboard/version` every 30 seconds;
2. uses an ETag so unchanged responses can return `304 Not Modified`;
3. compares Flow, Route, and health resource versions;
4. fetches only resources that changed;
5. switches traffic tiles when a new snapshot version appears;
6. retains currently displayed valid data while new data loads.

The browser also checks after regaining focus, becoming visible, returning
online, or restoring a page. A failed version check is retried automatically
after 10 seconds.

Users do not need to click Refresh, Retry, or reload the page for normal data
updates. Those controls are recovery options only.

Automatic latest-data polling is disabled in historical mode because an exact
historical slot is intentionally immutable.

## 8. Request and cache behavior

### 8.1 Initial page request

1. Next.js renders the page on the server.
2. The server reads the current Redis snapshot when available.
3. It validates the latest source identity against MySQL.
4. A matching snapshot is returned.
5. If the snapshot is absent or outdated, the application can materialize a
   replacement from the valid MySQL result.
6. React hydrates the page and starts client-side version polling.

### 8.2 JSON cache-aside

For cacheable API operations:

1. a deterministic key is created from resource, identity, and scope;
2. Redis is checked;
3. a valid compressed value is returned on a hit;
4. MySQL or the source view is read on a miss;
5. the result is compressed and stored when it fits the configured limit.

Latest values have a short default TTL. Exact historical values have a longer
default TTL.

### 8.3 Traffic snapshot

Each traffic snapshot contains:

- an identity derived from schema, source run, slot, status, coverage, feature
  count, and resource versions;
- a dashboard payload without the full province Flow collection;
- precomputed traffic summaries for confidence thresholds;
- gzip-compressed Mapbox vector tiles for zoom levels 7 through 14;
- separate road-line and pulse-point source layers;
- a public tile manifest;
- a current pointer.

Configured limits protect Redis from unbounded payloads:

- dashboard entry limit;
- individual tile limit;
- total traffic-snapshot limit;
- snapshot TTL.

## 9. Freshness and failure behavior

The application distinguishes:

- **fresh**: the selected latest source is valid and current;
- **running**: a newer upstream collection is still in progress;
- **partial**: the collection completed with incomplete coverage;
- **stale**: the retained valid slot is older or a newer collection failed;
- **unavailable**: no valid source or snapshot can be served.

Failure handling follows the last-known-good rule:

- a failed upstream run does not replace the latest valid run;
- a failed worker build does not publish its pointer;
- a failed browser request does not erase displayed data;
- a MySQL refresh failure may fall back to the previous validated Redis
  snapshot, explicitly marked stale;
- production never hides missing source data with fixtures.

`data.meta.stale` becomes `false` only after a valid eligible source run is
successfully materialized and served. It is not a UI preference that should be
manually changed.

## 10. API organization

| API group | Purpose |
| --- | --- |
| `/api/v1/dashboard/*` | Version checks and explicit dashboard refresh |
| `/api/v1/traffic/*` | Overview, current snapshot, window status, and tiles |
| `/api/v1/flow/*` | Flow map, slots, and segment history |
| `/api/v1/routes/*` | Route definitions, latest conditions, geometry, and history |
| `/api/v1/mobility/*` | Scope, readiness, model runs, zones, flows, centers, and grid |
| `/api/v1/mobility/catchments/*` | Public gravity-here-v2 catchment contract |
| `/api/internal/v1/mobility/catchments/*` | Feature-gated internal v2 preview |
| `/api/v1/operations/*` | Authorized collector details |
| `/api/v1/ops/*` | Authorized source-contract and run diagnostics |
| `/api/v1/export/*` | CSV and GeoJSON exports |
| `/api/v1/health` | Application, MySQL, and Redis readiness |

The authoritative request and response details are maintained in
`docs/openapi.yaml`.

## 11. Data contracts and semantics

The application uses the following conventions:

- `collection_slot_utc` is the analytical time axis;
- `source_updated_utc` and `fetched_at_utc` are lineage timestamps;
- latest mode selects the newest eligible successful or partial run containing
  usable observations;
- historical mode requires the requested exact slot;
- geometry uses WGS84/SRID 4326;
- Flow viewport reads use spatial bounding and intersection checks;
- route sections are returned in source section order;
- every API response includes metadata describing source, run, slot, freshness,
  status, model identity, coverage, and semantics where applicable.

Source serving views are versioned so database evolution does not silently
change the API contract.

## 12. Security and access

Current application controls include:

- a SELECT-only MySQL account, verified in production with `SHOW GRANTS`;
- no database write path in the application;
- CORS allow-list enforcement;
- feature flags and release gates;
- bearer-token authorization for restricted operations APIs;
- timing-safe token comparison;
- request rate limiting;
- bounded query limits and timeouts;
- bounded Redis payloads and decompression output;
- public-safe errors without credentials or raw provider failures;
- non-root Docker runtime users;
- demo fixtures rejected in production.

The current rate limiter is process-local. A multi-replica production
deployment should move enforcement to an ALB/WAF, reverse proxy, or shared
Redis-backed limiter.

## 13. Deployment model

The Dockerfile produces two runtime targets:

| Image target | Process |
| --- | --- |
| `web-runtime` | `node server.js` |
| `worker-runtime` | snapshot worker or one-shot builder |

`docker-compose.yaml` defines:

- `web`;
- `snapshot-worker`;
- maintenance-profile `snapshot-builder`.

`docker-compose.local.yaml` adds a local Redis instance configured with:

- 512 MiB maximum memory;
- `allkeys-lru` eviction;
- no persistence, because the cache is rebuildable.

Production should replace the local Redis service with private
Redis/ElastiCache and provide the RDS and cache endpoints through deployment
configuration and a secrets manager.

The web and worker should be deployed as separate services or task definitions
because they have independent lifecycle, scaling, and health requirements. Only
one worker replica should run unless a distributed build lock is added.

## 14. Testing and release validation

The repository includes:

- unit tests for calculations, validation, caching, refresh planning, and
  source behavior;
- integration tests for database contracts;
- Playwright browser tests;
- TypeScript type checking;
- Next.js production builds;
- database and release-gate scripts;
- source-contract checks;
- boundary and geography validation.

Typical validation:

```bash
npm test
npx tsc --noEmit
npm run build
npm run test:browser
RUN_MYSQL_CONTRACT_TESTS=1 npm run test:integration
```

Production-shaped local startup:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

One-time snapshot build:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml \
  --profile maintenance run --rm snapshot-builder
```

## 15. Important boundaries and non-goals

- The application does not call HERE to collect production traffic.
- The application does not write to the data warehouse.
- Redis is not a replacement for the authoritative MySQL data.
- A basemap is not a traffic or mobility data source.
- Predicted mobility is not a people-counting system.
- Opposite route directions are not inferred from each other.
- A stale banner is not cleared manually; freshness follows source validity.
- Incidents and unsupported analytics remain gated until real production
  contracts exist.
- The current application is a modular monolith, not a distributed
  microservices platform.

## 16. Related documentation

- `README.md` — setup and high-level source contract;
- `docs/oxman-krebs-development-report.md` — development reconstruction through the Krebs Cycle of Creativity;
- `docs/openapi.yaml` — HTTP API contract;
- `docs/development-guide.md` — engineering workflow and performance guidance;
- `docs/cloud-deployment-runbook.md` — production deployment and operations;
- `docs/traffic-snapshot-runbook.md` — snapshot construction and recovery;
- `docs/automation-team-alignment.md` — ownership and feature gates;
- `docs/step-3-source-dashboard.md` — database serving-view and release-gate contract.
