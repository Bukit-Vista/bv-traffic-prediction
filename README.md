# Atlas · Bali Traffic Intelligence

Read-only Next.js dashboard for Bali traffic, route performance, and internal
tourism-catchment mobility analysis. The current MVP contains:

- latest and exact-slot historical HERE traffic;
- a MapLibre jam heatmap sampled from real HERE road geometry and weighted by measured jam factor/confidence;
- all active monitored routes, canonical durations/ratios, history, and actual ordered HERE geometry;
- Flow and `n8n-here-routes` collection health;
- 21 modeled tourism catchments plus approved display-only geography;
- traffic-guided directional OD animation with DPS Airport Gateway as the default focus;
- a source-aggregated 3D places grid and persistent edge detail cards;
- OpenStreetMap tiles as cartographic context only.

## Feature overview

- **Live Traffic:** HERE road conditions, vector-tile map, congestion heatmap,
  confidence filters, closures, summaries, and exact-slot history.
- **Predicted Mobility:** feature-gated tourism catchments, relative mobility,
  directional OD flows, traffic-guided paths, places
  context, and model identity.
- **Route Performance:** seven bidirectional DPS Airport corridors, independent
  route directions, current/typical/base durations, geometry, and history.
- **Data Health:** Flow and Route collection freshness, coverage, retries,
  partial/failed/stuck states, and restricted operations details.
- **Exports:** Flow CSV/GeoJSON, routes CSV, mobility flows CSV, and mobility
  zones GeoJSON.
- **Snapshot updates:** production pages and browser refreshes read Redis only.
  An authorized manual refresh builds and atomically publishes a new snapshot;
  latest-mode browsers poll the lightweight Redis version pointer every 30
  seconds and adopt a newly published version.

Feature flags control mobility and places serving. Unsupported incidents and
analytics remain unavailable until their production gates pass. Production never
substitutes fixtures.

All analytical timestamps use `collection_slot_utc`. `source_updated_utc` and `fetched_at_utc` are exposed separately for lineage. Stored/API timestamps are UTC and the interface displays WITA (`Asia/Makassar`).

## Source contract

The application reads the automation team’s existing schema. Do **not** apply the repository’s older mobility migration over the audited production database.

Required sources:

- `traffic_flow_collection_runs`, `traffic_flow_observations`, `traffic_flow_latest`, `traffic_road_segments`;
- `routes`, `ingestion_runs`, `route_samples`, `route_sample_geometries`.

Step 3 requires these versioned serving views:

- `api_mobility_scope_v1`, `api_airport_destinations_v1`;
- `api_airport_tourism_routes_v1`, `api_airport_route_latest_v1`, `api_airport_route_slots_v1`;
- `api_traffic_flow_latest_v1`, `api_source_status_v1`.
- `api_collector_alert_state_v1`, `api_flow_run_history_v1`, `api_route_run_history_v1`.

The final route detail cutover also requires `api_airport_route_history_v1` and
`api_airport_route_geometry_v1`. The application reads those views first and can temporarily use
the normalized legacy route tables only when `ROUTE_READ_CONTRACT_FALLBACK_ENABLED=true`. Set
`STEP3_ROUTE_VIEWS_REQUIRED=true` and disable the fallback after data engineering deploys both views.

`GET /api/v1/mobility/scope` and `GET /api/v1/mobility/airport-destinations/config` expose configuration only, even while the scope is draft. `GET /api/v1/routes` returns route definitions, while `GET /api/v1/routes/latest` returns measured HERE conditions and is the endpoint used by the dashboard. All other mobility endpoints remain `503 FEATURE_NOT_READY` while `prediction_enabled = 0`.

Route Performance reads only active `airport_tourism` definitions, grouped into seven DPS Airport corridor pairs. Each `from_airport` and `to_airport` direction remains an independent measurement; missing directions are never filled from the reverse route.

Release and operations checks validate non-null slot/duration columns, the
unique Flow and Route slot indexes, populated latest pointers, duplicate Route
slots, and SRID 4326 route geometry. These full-catalogue checks are deliberately
excluded from page rendering and snapshot refreshes. They remain available to
an authorized operations role at `GET /api/v1/ops/source-contract`.

Flow viewport reads use a prepared WGS84 polygon, `MBRIntersects`, and `ST_Intersects`. Latest mode uses `traffic_flow_latest`; historical mode requires an exact eligible collection slot. Route selection is independent per active route and geometry is returned in `section_index` order.

The live dashboard uses an immutable Redis traffic cache. MapLibre downloads
only visible, precomputed HERE traffic line and pulse-point vector tiles; page
loads, pan, zoom, confidence changes, and the 30-second
`/api/v1/dashboard/version` check never query MySQL. If the snapshot is
unavailable, production returns an explicit unavailable state until an
authorized manual refresh publishes a replacement. Exact historical slots
continue to use their bounded API response.

## Configuration

```dotenv
APP_TIMEZONE=Asia/Makassar
DASHBOARD_DEMO_MODE=false
HERE_SOURCE_CUTOVER_ENABLED=true
BALI_SOURCE_DASHBOARD_ENABLED=true
AIRPORT_TOURISM_ROUTES_ENABLED=true
DASHBOARD_CONDITIONAL_CACHE_ENABLED=true
REDIS_URL=rediss://cache-endpoint:6379
REDIS_CACHE_ENABLED=true
REDIS_CACHE_REQUIRED=true
REDIS_CACHE_NAMESPACE=bali-traffic
REDIS_CACHE_TTL_LATEST_SECONDS=60
REDIS_CACHE_TTL_HISTORICAL_SECONDS=86400
REDIS_CACHE_MAX_VALUE_BYTES=8388608
ROUTE_READ_CONTRACT_FALLBACK_ENABLED=true
STEP3_ROUTE_VIEWS_REQUIRED=false
OPERATIONS_API_TOKEN=replace-with-a-secret-manager-value
API_RATE_LIMIT_ENABLED=true
CORS_ALLOWED_ORIGINS=https://traffic.example.com
MYSQL_CONNECTION_LIMIT=6
MYSQL_QUERY_TIMEOUT_MS=15000
REDIS_TRAFFIC_CACHE_MODE=prefer
REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS=172800
REDIS_TRAFFIC_MAX_TOTAL_BYTES=335544320
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=bali_dashboard_reader
MYSQL_PASSWORD=...
MYSQL_DATABASE=bali_traffic
BASEMAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
BASEMAP_ATTRIBUTION=© OpenStreetMap contributors
BASEMAP_DEPLOYMENT_MODE=demo-internal
```

Demo mode defaults off and is rejected when enabled in production. The website requires a `SELECT`-only MySQL account and never accepts HERE credentials.

The community OSM tile service is best-effort for internal/demo use. Keep attribution, normal browser caching, and referrers enabled; do not proxy, prefetch, or bulk-download. Public-scale deployments must configure a managed or self-hosted OSM-derived source.

`GET /api/v1/health` checks the application, read-only database connection, and
configured Redis cache without contacting HERE.
Collector alert state is public through `GET /api/v1/traffic/overview`; detailed history is restricted to
`GET /api/v1/operations/collectors/**` with `Authorization: Bearer <OPERATIONS_API_TOKEN>`. Raw collector
errors, provider payloads, and credentials are never returned.

## Run and verify

```bash
npm ci
npm run snapshot:build
npm run release:gate
npm run dev
npm test
npx tsc --noEmit
npm run build
npm run test:browser
RUN_MYSQL_CONTRACT_TESTS=1 npm run test:integration
```

Run the production-shaped containers against a local 512 MiB Redis cache with:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up --build
```

The local override reaches a host MySQL server through `host.docker.internal`.
Set `DOCKER_MYSQL_HOST` if the database is elsewhere.
The continuous `snapshot-worker` is disabled from the default Compose profile.
Production refreshes are manual so a database slowdown cannot create a retry
loop. To build and publish a snapshot through the protected application path:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $OPERATIONS_API_TOKEN" \
  https://traffic.example.com/api/v1/dashboard/refresh
```

The endpoint permits at most two attempts per five minutes per web process and
uses a fixed 120-second shared Redis cooldown lock so only one process can start
a live refresh. Production snapshot-only behavior and database safety limits are
enforced by the application and require no new environment settings.
The public dashboard Refresh button only reloads the latest published Redis
snapshot.

If continuous refresh is intentionally re-enabled later, start its explicit
profile:

```bash
docker compose --profile automatic-refresh up -d snapshot-worker
```

Run the one-shot snapshot builder with:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml \
  --profile maintenance run --rm snapshot-builder
```

Run `npm run snapshot:build` from the automation workflow after Flow and Route writes have completed. The command generates and validates the dashboard payload and vector tiles, writes versioned Redis keys with TTLs, and publishes the current-version pointer only after all values are ready. See [the snapshot runbook](docs/traffic-snapshot-runbook.md).

The OpenAPI contract is [docs/openapi.yaml](docs/openapi.yaml). Automation ownership and future mobility gates remain documented in [docs/automation-team-alignment.md](docs/automation-team-alignment.md).
The implemented Step 3 contract, database-view handoff, and release gate are recorded in [docs/step-3-source-dashboard.md](docs/step-3-source-dashboard.md).

Production infrastructure and release operations are documented in the
[cloud deployment runbook](docs/cloud-deployment-runbook.md). Repository
architecture, testing, performance constraints, and the recommended future
development workflow are documented in the
[development guide](docs/development-guide.md).
The application archetype, programming style, runtime components, feature
catalog, data flows, caching behavior, and snapshot refresh lifecycle are
documented in the
[application architecture and feature guide](docs/application-architecture.md).

The deployment uses a Dockerized Next.js web process plus on-demand snapshot
workloads on Amazon EC2, connected privately to the existing RDS MySQL database
and an ElastiCache Redis/Valkey endpoint. The scheduled worker is an explicit
opt-in profile; a maintenance-profile builder is available for one-shot recovery
builds.
Compressed, bounded GeoJSON responses, dashboard snapshots, and immutable traffic
vector tiles all use Redis. No local cache volume or native cache database is required.

The documentation catalog and maintenance policy are in
[docs/README.md](docs/README.md).

Production cutover should remain behind the source flag in staging until Flow and Route collection have completed 24 stable hours.

## Gravity-here-v2 tourism catchments

The 22-catchment experience has separate internal-preview and public rollout
controls. Public v2 endpoints are:

- `GET /api/v1/mobility/catchments/overview`
- `GET /api/v1/mobility/catchments/zones`
- `GET /api/v1/mobility/catchments/flows`
- `GET /api/v1/mobility/catchments/centers`

The server requires `gravity-here-v2`, an active model, a successful run,
21 modeled zones, 420 directed pairs, at least 0.90 input coverage, null run
errors, and `public_serving_enabled = 1`. The application rollout flag remains
an independent requirement. The legacy nine-area endpoints stay isolated for
rollback and never consume a generic active-model result.

Both flags default off:

```dotenv
MOBILITY_CATCHMENT_SHADOW_UI_ENABLED=false
MOBILITY_CATCHMENT_SHADOW_UI_FLAG_ACTOR=deployment-actor
MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED=false
MOBILITY_CATCHMENT_V2_PUBLIC_FLAG_ACTOR=deployment-actor
```

Before enabling public v2, verify a scheduled run newer than the activation
evidence:

```bash
npm run release:gate:mobility-v2 -- --after-model-run-id <activation-run-id>
```

The run ID is supplied only to the release command and is never hard-coded.
See [the v2 cutover contract](docs/step-09f-internal-catchment-preview.md).
