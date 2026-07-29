# Redis traffic-cache runbook

Status: current operations guidance. Last reviewed: 29 July 2026.

## Purpose

Move dashboard read and rendering work out of the request path. The long-running
worker automatically materializes the newest eligible HERE Flow and Route state
and stores the reduced dashboard payload plus precomputed vector tiles in Redis.
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
SNAPSHOT_REFRESH_INTERVAL_MINUTES=30
SNAPSHOT_REFRESH_OFFSET_MINUTES=12
REDIS_TRAFFIC_MAX_DASHBOARD_BYTES=8388608
REDIS_TRAFFIC_MAX_TILE_BYTES=2097152
REDIS_TRAFFIC_MAX_TOTAL_BYTES=335544320
```

No local cache directory, persistent volume, or filesystem lock is required. The
web, long-running worker, and one-shot builder containers must use the same Redis
endpoint and namespace.

## Automatic scheduling

The `snapshot-worker` runs immediately at startup, then aligns builds to `:12`
and `:42` with the default 30-minute interval and 12-minute offset. It retries a
failed build after one minute and prewarms enabled mobility caches after every
successful traffic snapshot.

Start the production-shaped local services with:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

Use the one-shot builder for initial cache creation or recovery:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml \
  --profile maintenance run --rm snapshot-builder
```

An upstream automation workflow may also trigger the one-shot builder immediately
after an accepted collection. Deterministic versioned keys make repeated builds
safe, and the current pointer is published only after the complete version is
ready. Do not run multiple long-running worker replicas unless a distributed
build lock is added.

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

## Runtime modes

- `prefer` (default): use Redis when valid and fall back to live MySQL.
- `require`: fail when the Redis traffic cache is unavailable or invalid.
- `off`: bypass the Redis traffic cache and use MySQL directly.

Use `require` only after the post-collection builder and Redis monitoring have been
stable in staging.

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
