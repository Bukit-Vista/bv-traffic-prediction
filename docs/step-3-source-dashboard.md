# Step 3 source dashboard implementation

Status: implemented source-serving and cutover record. Last reviewed: 29 July
2026.

## Goal

Serve a production, source-only Bali traffic product from normalized HERE Flow and Route data. The product describes measured traffic and route conditions only. It does not claim people, tourist, trip, device, footfall, or vehicle counts.

## Implemented application contract

- The public overview reads the redacted Flow and Route states from `api_collector_alert_state_v1`.
- Latest Flow map reads `api_traffic_flow_latest_v1` through a prepared WGS84 viewport, with bounded bbox, confidence, feature count, query time, response size, and request rate.
- Route definitions, latest measurements, and slots read the existing versioned `api_*_v1` views.
- Route history defaults to a bounded seven-day/168-point request and preserves null and negative measurements.
- Route geometry returns all HERE sections in `section_index` order and does not substitute a different exact slot.
- Detailed Flow and Route run histories read their versioned views through bearer-protected `/api/v1/operations/collectors/**` endpoints. Public users see current redacted health only.
- API metadata includes request time, collection slot, source, freshness, staleness, coverage, and stable error/request IDs.
- MySQL uses a conservative shared read pool and per-query timeout. CORS, rate limiting, and the `BALI_SOURCE_DASHBOARD_ENABLED` release gate are configurable.
- The UI keeps last-valid data during refresh failures, separates latest and historical modes, shows seven bidirectional airport corridors, supports sorting and bounded history ranges, and displays current/typical/base duration plus delay and ratio trends.

## Remaining database-owned cutover

The deployed database does not yet contain:

- `api_airport_route_history_v1`
- `api_airport_route_geometry_v1`

The reviewed definitions are in `database/migrations/002_step3_route_read_views.sql`. Until the database owner applies them, the backend uses a missing-view-only fallback to normalized `route_samples` and `route_sample_geometries` and declares `legacy_route_tables_fallback` in response metadata. No raw provider JSON is read or returned.

After the views are deployed:

1. Set `STEP3_ROUTE_VIEWS_REQUIRED=true`.
2. Set `ROUTE_READ_CONTRACT_FALLBACK_ENABLED=false`.
3. Run `RUN_MYSQL_CONTRACT_TESTS=1 npm run test:integration`.
4. Confirm all 14 routes have latest measurements and ordered geometry.

## Release gate

The source dashboard defaults off in production unless `BALI_SOURCE_DASHBOARD_ENABLED=true`. Keep it disabled until A7 passes: 48/48 Flow slots, 24/24 Route slots, no partial/failed slots, no duplicate identities, no stuck runs, no pointer regression, no new connection errors, and 14 latest routes/geometries. Development and staging validation can continue with the flag enabled.

Operations must configure `OPERATIONS_API_TOKEN` through the deployment secret manager and an explicit `CORS_ALLOWED_ORIGINS` value. The browser must never receive MySQL, HERE, or n8n credentials or raw collector errors.

Production startup fails closed when the configured account has mutation
privileges. The application environment now uses the dedicated
`datawarehouse_reader` account with `USAGE` and `SELECT` grants only. Keep this
grant check in the release gate; it cannot be disabled in a production process.
