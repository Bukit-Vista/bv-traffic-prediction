# Redis traffic-cache runbook

Status: current operations guidance. Last reviewed: 29 July 2026.

## Purpose

Move dashboard read and rendering work out of the request path. An authorized
manual refresh materializes the newest eligible HERE Flow and Route state and
stores the reduced dashboard payload plus precomputed vector tiles in Redis.
The one-shot builder performs the same operation for initial creation or recovery.
Requests read versioned Redis keys instead of executing MySQL spatial joins or
generating heat points in the browser.

MySQL remains the source of truth. Redis is rebuildable cache storage and is not a
database backup.

## One-shot build command

For an explicit one-time build outside Compose, run this only after the
automation workflow has committed Flow observations, latest pointers, Route
samples, geometry, and collection-run status:

```bash
npm run snapshot:build
```

Required configuration is the existing read-only MySQL configuration plus:

```dotenv
REDIS_URL=rediss://cache-endpoint:6379
REDIS_CACHE_ENABLED=true
REDIS_CACHE_REQUIRED=true
REDIS_TRAFFIC_CACHE_MODE=prefer
REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS=172800
REDIS_TRAFFIC_MAX_DASHBOARD_BYTES=8388608
REDIS_TRAFFIC_MAX_TILE_BYTES=2097152
REDIS_TRAFFIC_MAX_TOTAL_BYTES=335544320
```

No local cache directory, persistent volume, or filesystem lock is required. The
web and one-shot builder containers must use the same Redis
endpoint and namespace.

## Manual production refresh

The continuous `snapshot-worker` is outside the default Compose profile. This
prevents a slow database statement from creating an automatic retry loop.

Start the production-shaped local services with:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

Use the protected application endpoint for an operational refresh:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $OPERATIONS_API_TOKEN" \
  https://traffic.example.com/api/v1/dashboard/refresh
```

Use the one-shot builder for initial cache creation or recovery:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml \
  --profile maintenance run --rm snapshot-builder
```

An upstream automation workflow may trigger the one-shot builder immediately
after an accepted collection. Deterministic versioned keys make repeated builds
safe, and the current pointer is published only after the complete version is
ready.

## Atomic activation and retention

The builder:

1. Reads one reconciled dashboard state from MySQL.
2. Validates the source run, exact slot, feature set, and resource versions.
3. Precomputes HERE traffic lines and pulse points into zoom 7–14 vector tiles.
4. Gzip-compresses the dashboard payload and each vector tile.
5. Rejects individual or total output that exceeds configured Redis budgets.
6. Writes all versioned tile keys with TTLs.
7. Writes the versioned dashboard key with the same TTL.
8. Publishes the current-version pointer last.

A failed build never replaces the active pointer. Previous immutable versions stay
available until their TTL expires, allowing in-flight browsers to finish using an
older tile URL.

## Production runtime behavior

Production page rendering always requires a published snapshot. Public traffic
cannot enable a live MySQL fallback through deployment configuration. The
manual refresh cooldown is fixed at 120 seconds in application code, so no new
production environment settings are required.

## Health verification

After every build, verify:

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:3000/api/v1/dashboard/version
curl -fsS http://127.0.0.1:3000/api/v1/traffic/snapshot
```

The health response must report `redis: "ok"`. The returned tile version, Flow
`sourceRunId`, and slot must match the accepted automation run. Tile requests use
`/api/v1/traffic/tiles/{version}/{z}/{x}/{y}` and return an immutable one-year
browser cache header.

In latest mode, browsers check `/api/v1/dashboard/version` every 30 seconds and
switch automatically when the active pointer changes. Failed version checks retry
after 10 seconds. Users do not need to reload the page or click Retry.

## Capacity and monitoring

The default traffic-cache budget is 320 MiB, leaving room on a nominal 512 MiB node
for Redis overhead, key metadata, short-lived API responses, and fragmentation.
Monitor:

- `BytesUsedForCache` and freeable memory;
- cache hit/miss rate;
- evictions;
- current traffic-cache build size and tile count;
- builder duration and failures;
- Redis connection latency and errors.

Use an `allkeys-lru` or approved equivalent eviction policy. If normal operation
approaches the total budget, increase the Redis node size before raising the
application limit.
