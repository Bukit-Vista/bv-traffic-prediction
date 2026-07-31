# Redis traffic-cache runbook

Status: current operations guidance. Last reviewed: 29 July 2026.

## Purpose

Move dashboard read and rendering work out of the request path. A bounded
scheduled or authorized manual refresh materializes the newest eligible HERE Flow and Route state and
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

The bundled Redis service uses an AOF-backed named Docker volume. Managed
production Redis should provide equivalent replication/persistence. The web and
one-shot builder containers must use the same Redis endpoint and namespace.

## Automatic and manual production refresh

The `snapshot-worker` is part of the default Compose services. It runs at startup
and then at `:12` and `:42`. A renewable owner-token Redis lease permits only one refresh across
replicas. Each scheduled check compares lightweight source identities first; it
does not run the full dashboard read or tile build when Redis already represents
the current completed source state. Failures use bounded exponential backoff.
The schedule and backoff are fixed in code and require no new environment values.

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
6. Writes persistent versioned tiles, dashboard payload, and completeness manifest.
7. Publishes the persistent current-version pointer last.
8. Applies the configured retirement TTL to the replaced version.

A failed build never replaces the active pointer. The active snapshot does not
expire; previous immutable versions remain available until their retirement TTL
expires, allowing in-flight browsers to finish using an older tile URL.

## Production runtime behavior

Production page rendering always requires a published snapshot. Public traffic
cannot enable a live MySQL fallback through deployment configuration. Scheduled
and manual refreshes share a renewable 15-minute Redis lease that is released
after completion. Ownership is checked again immediately before the current
pointer is published. No new production environment settings are required.

## Health verification

After every build, verify:

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:3000/api/v1/dashboard/version
curl -fsS http://127.0.0.1:3000/api/v1/traffic/snapshot
```

The health response must report `redis: "ok"`, `snapshot.status: "ok"`, and
`worker.status: "ok"`. The worker writes a Redis heartbeat every 30 seconds;
Docker marks it unhealthy when the heartbeat is missing or older than three minutes.
Readiness checks Redis, the dashboard payload, manifest, and one real tile
without querying MySQL. The returned tile version, Flow `sourceRunId`, and slot
must match the accepted automation run. Tile requests use
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

Use a `volatile-lru` or approved equivalent eviction policy so expiring cache
entries and retired versions are reclaimed before the persistent active
snapshot. If normal operation approaches the total budget, increase the Redis
node size before raising the application limit.
