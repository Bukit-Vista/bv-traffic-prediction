# Cloud deployment handoff

Status: current production deployment guidance. Last reviewed: 29 July 2026.

This document is the production deployment contract for the Bali Traffic web
application and read APIs. It records the agreed MVP architecture and separates it
from future scale-out work.

Data collectors, database migrations, and mobility-model writers remain separate
workloads. They do not run inside the public web container.

## 1. Approved MVP decisions

| Area | Decision |
| --- | --- |
| Compute | One Amazon EC2 instance in the Jakarta region |
| Packaging | Separate minimal Docker images for the Next.js web and on-demand snapshot workloads |
| Database | Existing Amazon RDS for MySQL; do not migrate to PostgreSQL |
| Database access | Private network, TLS, and a SELECT-only web account |
| Cache store | ElastiCache Redis OSS/Valkey for JSON, GeoJSON, dashboard state, and vector tiles |
| Snapshot behavior | Fixed twice-hourly Redis-coordinated refresh, plus authorized manual recovery |
| Cache retention | Active traffic version persists; replaced versions expire after 48 hours |
| Reverse proxy | Caddy terminates TLS and proxies to the web container |
| Redis | Private ElastiCache Redis OSS/Valkey for all shared application cache data |
| S3/CloudFront | Not required to run the current app; consider during scale-out |

The application is not a static site. S3 alone cannot host its server-rendered
Next.js pages or API routes.

Redis contains all shared cache data: API JSON/GeoJSON, the reduced dashboard
payload, the current traffic-version pointer, and immutable vector tiles. MySQL
remains authoritative, and Redis data is always rebuildable.

## 2. Production topology

```text
Internet
   |
   v
Caddy on EC2 (TLS, compression, access logs)
   |
   v
Docker: Next.js web container (one process, port 3000)
   |                  |
   |                  v
   |             ElastiCache Redis/Valkey <--- authorized manual refresh
   |             JSON + GeoJSON +              or one-shot builder
   |             dashboard + vector tiles               |
   v                                                     |
Amazon RDS for MySQL (private endpoint, SELECT-only account) <---+

Collectors/model workers --> RDS MySQL
                         \--> optional immediate one-shot snapshot build
```

One web container, one scheduled snapshot worker, and an on-demand snapshot
builder are intentional:

- public page loads and browser refreshes never materialize a missing Redis
  version from MySQL;
- API rate limiting is held in process memory;
- all shared cache values are stored in Redis;
- one process keeps the remaining rate-limit state consistent;
- MapLibre renders in the browser, so the server primarily handles SSR, JSON, and
  immutable vector-tile reads.
- an authorized manual operation builds cache data independently of browser
  traffic and is protected by a renewable owner-token Redis lease.

Do not add a second web replica until the scale-out prerequisites in section 16
are complete.

## 3. Initial AWS sizing

For the expected initial traffic of approximately 10 users per day, start with:

- EC2 `t4g.medium`: 2 vCPU and 4 GiB RAM;
- Ubuntu 24.04 LTS ARM64;
- 40 GiB gp3 EBS storage;
- RDS MySQL `db.t4g.micro`, Single-AZ, with gp3 storage;
- EC2 and RDS in the same AWS region and VPC;
- one small ElastiCache node (for example `cache.t4g.micro`) with encryption in
  transit; it has approximately 0.5 GiB physical memory, but usable data capacity
  is lower after engine and reserved-memory overhead;
- no Application Load Balancer while there is only one instance.

The container image must support `linux/arm64`.

Scale from measured CPU, memory, API latency, database saturation, and availability
requirements rather than user-count estimates alone.

## 4. Production responsibilities

| Component | Responsibility | Required access |
| --- | --- | --- |
| Caddy | Public TLS, compression, security headers, access logs | Loopback web port |
| Next.js web container | Dashboard, APIs, SSR, protected manual refresh, tiles | SELECT-only MySQL; Redis |
| Snapshot-worker container | Optional scheduled Redis snapshot creation and mobility-cache prewarming | SELECT-only MySQL; Redis |
| Snapshot-builder container | One-shot initial, post-collection, or recovery cache creation | SELECT-only MySQL; Redis |
| ElastiCache Redis/Valkey | All shared compressed cache data and vector tiles | Application security group only |
| RDS MySQL | Source observations, routes, model output, serving views | Writers plus restricted readers |
| Collector/model workers | Collection and model writes | Separate write credentials |

Never place MySQL write credentials, HERE credentials, or collector credentials in
the public web container.

## 5. Required AWS infrastructure and networking

Provision:

1. One EC2 instance with an attached gp3 EBS volume.
2. One RDS MySQL database reachable through a private endpoint.
3. One ElastiCache Redis OSS/Valkey cache reachable only inside the VPC, with
   encryption in transit and an eviction policy suitable for cache data.
4. DNS for the public application hostname.
5. AWS Systems Manager Session Manager or restricted administrative SSH access.
6. Secrets Manager or Parameter Store entries for the database password and
   operations API token.
7. An EC2 security group allowing:
   - inbound `80/tcp` and `443/tcp` from the internet;
   - no public access to container port `3000`;
   - administrative access only through the approved management path.
8. An RDS security group allowing `3306/tcp` only from the EC2 security group and
   approved collector/worker security groups.
9. An ElastiCache security group allowing its Redis port only from the EC2
   application security group.

Do not expose RDS publicly. Keep EC2 and RDS in the same region and use their private
addresses for application traffic.

## 6. EC2 host and container contract

Install Docker Engine, the Docker Compose plugin, Caddy, and the AWS management
agent on the EC2 host. Node.js does not need to be installed on the host.

Create host deployment directories:

```bash
sudo install -d -m 0750 /opt/bali-traffic
sudo install -d -m 0750 /etc/bali-traffic
```

The Docker deployment must define these workloads:

| Workload | Command | Lifetime |
| --- | --- | --- |
| `web` | `node server.js` | Long-running |
| `snapshot-builder` | `node --import tsx scripts/build-traffic-snapshot.ts` | One-shot |
| `snapshot-worker` | `node --import tsx scripts/run-traffic-snapshot-worker.ts` | Long-running bounded scheduler |

The web workload uses the minimal Next.js standalone image. Snapshot workloads use
a separate worker image containing production dependencies and only the two
snapshot entrypoints. All workloads share the environment contract, Redis endpoint,
and Redis namespace. Publish container port `3000` only to `127.0.0.1:3000` on the
host. Use `restart: unless-stopped` for the web and snapshot-worker containers.
The worker timing is fixed at `:12` and `:42`; its renewable Redis lease prevents
concurrent refreshes, and its lightweight identity check skips full reads when
the completed source state has not changed. A 30-second Redis heartbeat drives
the container health check without querying MySQL.

The production image must:

- use Node.js 24 LTS;
- contain only the compiled standalone application or worker runtime dependencies;
- run as a non-root user;
- receive secrets at runtime rather than baking them into an image layer;
- include the snapshot-builder runtime (`tsx` is currently required by the script).

The committed `Dockerfile`, `.dockerignore`, and `docker-compose.yaml` are the canonical
container artifacts. The image runs as the non-root `node` user (UID 1000).

## 7. Database contract

Keep the existing MySQL schema and serving views. Do not convert the application to
PostgreSQL as part of this deployment.

Create a dedicated web account and grant only `SELECT` on approved tables and
versioned serving views. Do not grant `INSERT`, `UPDATE`, `DELETE`, DDL, `EXECUTE`,
or `GRANT OPTION`.

Production validates `SHOW GRANTS` and rejects an application account with
mutation privileges.

The current MySQL client configuration does not yet provide a CA bundle or
enable certificate validation. Private networking does not replace encryption
in transit. Add CA-validated RDS TLS support before treating the deployment as
public-production ready; do not restore a boolean SSL switch that accepts an
unverified server certificate.

Use a private RDS hostname and the discrete connection fields:

```dotenv
MYSQL_HOST=mysql.private.example
MYSQL_PORT=3306
MYSQL_USER=bali_dashboard_reader
MYSQL_PASSWORD=secret-manager-value
MYSQL_DATABASE=bali_traffic
MYSQL_CONNECTION_LIMIT=6
MYSQL_QUERY_TIMEOUT_MS=15000
```

The application caps its read pool at two connections, its wait queue at 20,
and its server statement timeout to one second below `MYSQL_QUERY_TIMEOUT_MS`.
These safety limits do not require new deployment settings.

Keep total connections below the RDS limit with at least 30% headroom:

```text
web pools + snapshot-builder pools + collector/model pools
< 70% of database max connections
```

## 8. Production environment

Render the production environment to:

```text
/etc/bali-traffic/bali-traffic.env
```

Limit the file to root and the deployment group, and pass it to containers through
the runtime configuration. Do not copy it into the image.

Recommended values:

```dotenv
NODE_ENV=production
APP_TIMEZONE=Asia/Makassar

DASHBOARD_DEMO_MODE=false
HERE_SOURCE_CUTOVER_ENABLED=true
BALI_SOURCE_DASHBOARD_ENABLED=true
AIRPORT_TOURISM_ROUTES_ENABLED=true

MOBILITY_SHADOW_READ_ENABLED=true
MOBILITY_SHADOW_UI_ENABLED=false
MOBILITY_PLACES_LAYER_ENABLED=true
MOBILITY_CATCHMENT_SHADOW_UI_ENABLED=true
MOBILITY_CATCHMENT_SHADOW_UI_FLAG_ACTOR=production-deployment
MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED=false
MOBILITY_CATCHMENT_V2_PUBLIC_FLAG_ACTOR=production-deployment

DASHBOARD_CONDITIONAL_CACHE_ENABLED=true
REDIS_URL=rediss://primary.cache-id.xxxxxx.apse1.cache.amazonaws.com:6379
REDIS_CACHE_ENABLED=true
REDIS_CACHE_REQUIRED=true
REDIS_CACHE_NAMESPACE=bali-traffic-production
REDIS_CACHE_TTL_LATEST_SECONDS=60
REDIS_CACHE_TTL_HISTORICAL_SECONDS=86400
REDIS_CACHE_MAX_VALUE_BYTES=8388608
REDIS_CONNECT_TIMEOUT_MS=2000
ROUTE_READ_CONTRACT_FALLBACK_ENABLED=false
STEP3_ROUTE_VIEWS_REQUIRED=true
MVP_HISTORY_VIEWS_REQUIRED=true

API_RATE_LIMIT_ENABLED=true
OPERATIONS_API_TOKEN=secret-manager-value
CORS_ALLOWED_ORIGINS=https://traffic.example.com

MYSQL_HOST=mysql.private.example
MYSQL_PORT=3306
MYSQL_USER=bali_dashboard_reader
MYSQL_PASSWORD=secret-manager-value
MYSQL_DATABASE=bali_traffic
MYSQL_CONNECTION_LIMIT=6
MYSQL_QUERY_TIMEOUT_MS=15000

REDIS_TRAFFIC_CACHE_MODE=prefer
REDIS_TRAFFIC_SNAPSHOT_TTL_SECONDS=172800
REDIS_TRAFFIC_MAX_DASHBOARD_BYTES=8388608
REDIS_TRAFFIC_MAX_TILE_BYTES=2097152
REDIS_TRAFFIC_MAX_TOTAL_BYTES=335544320

BASEMAP_DEPLOYMENT_MODE=managed
BASEMAP_TILE_URL=https://managed-map-source.example/{z}/{x}/{y}.png
BASEMAP_ATTRIBUTION="Required attribution text"
```

The per-entry limit is measured after gzip compression. The default 8 MiB ceiling
prevents one response from crowding out the cache. The active traffic snapshot
is persistent; replaced versions and normal JSON cache entries have TTLs. The
ElastiCache parameter group should use `volatile-lru` (or the approved
equivalent) so expiring JSON entries and retired versions are evicted before the
persistent active snapshot. A 512 MiB node is a starting size,
not 512 MiB of guaranteed payload capacity; monitor bytes used, evictions, and
hit rate.

Use `REDIS_TRAFFIC_CACHE_MODE=prefer` for the MVP:

- a valid current Redis traffic version is used;
- public page rendering and version polling use Redis only;
- a missing snapshot returns an unavailable response instead of building from
  public traffic;
- an authorized refresh reads MySQL and publishes a complete version;
- a renewable owner-token Redis lease prevents concurrent refreshes across processes;
- snapshot publication failures return HTTP 503 without replacing the active pointer;

Set database-view requirement flags to `true` only after the corresponding views
are deployed.

## 9. Build and release

CI must run:

```bash
npm ci
npx tsc --noEmit
npm run test:unit
npm run build
```

Local production-shaped verification uses the repository's disposable 512 MiB
Redis service:

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up --build
```

Production uses `docker-compose.yaml` alone and supplies the private ElastiCache
`REDIS_URL` through `/etc/bali-traffic/bali-traffic.env`; it must not start the
local Compose Redis service.

After those checks pass:

1. Build the web and worker images for the EC2 architecture.
2. Tag both with the same immutable commit SHA or release ID.
3. Push them to Amazon ECR or the approved private registry.
4. Update the EC2 deployment to the immutable image digests.
5. Pull the images and recreate the web container.
6. Leave the shared Redis cache online during container replacement.

Do not build production images from an uncommitted EC2 working tree. Do not use a
floating `latest` tag as the rollback identity.

Caddy remains on the host for the MVP. Install the repository template, replace the
hostname, validate it, and proxy only to `127.0.0.1:3000`.

## 10. Database and release gates

Database migrations are not executed by the web deployment. Apply versioned views
through the database-owned migration workflow before enabling requirement flags.

Run these commands using a one-shot container from the same release image:

```bash
npm run release:gate
npm run release:gate:mvp
```

The one-shot container must receive the production read-only environment and have
private network access to RDS.

The gates verify collection windows, route geometry, latest pointers, duplicate
identities, stuck runs, connection errors, required views, and the SELECT-only
account.

## 11. Redis traffic-cache lifecycle

The normal event-driven sequence is:

1. Collectors commit and accept Flow and Route data in RDS MySQL.
2. The successful automation step calls the protected dashboard refresh endpoint.
3. The web service performs one bounded, shared-lock-protected MySQL refresh.
4. It creates and validates the compressed dashboard payload and vector tiles.
5. It writes the new version as persistent Redis values.
6. It atomically activates the version by writing the current pointer last.
7. It assigns the configured retirement TTL to the replaced version.
8. Browsers discover the new pointer during their 30-second Redis version poll.

Public traffic never materializes missing cache data and never polls MySQL.
Every successful build preserves the active version during validation; a failed
build does not change the active pointer.

A one-shot recovery build can execute from the deployed project directory:

```bash
docker compose -f /opt/bali-traffic/docker-compose.yaml --profile maintenance \
  run --rm snapshot-builder
```

An immediate post-collection trigger may be used in addition to the aligned
worker when orchestration can guarantee that all source/model writes are
complete. See [traffic-snapshot-runbook.md](traffic-snapshot-runbook.md) for
snapshot internals.

## 12. Deployment smoke test

After every deployment:

```bash
curl -fsS https://traffic.example.com/api/v1/health
curl -fsS https://traffic.example.com/
curl -fsS https://traffic.example.com/api/v1/dashboard/version
curl -fsS https://traffic.example.com/api/v1/traffic/snapshot
```

Then verify:

1. The initial loading overlay completes without manual refresh.
2. Live traffic roads and vector tiles render.
3. Road clicks open the edge detail card.
4. Predicted Mobility defaults to DPS Airport Gateway.
5. OD arrows continue animating after a feature is selected.
6. Catchment and stored places layers render as configured.
7. The container remains healthy and the Redis traffic version persists after a
   container recreation.

## 13. Monitoring and alerts

Collect:

- Caddy access logs and status codes;
- Docker container logs, health, restarts, CPU, memory, and open files;
- authorized snapshot build age, duration, failures, worker heartbeat, and lease state;
- API latency by route;
- MySQL pool wait time, query errors, and connection saturation;
- Redis used memory, hit/miss rate, evictions, connection failures, and latency;
- traffic-cache build age, duration, tile count, byte size, and active version;
- health endpoint, source-slot age, and collector status.

Alert on:

- health endpoint failure for two consecutive checks;
- no successful source slot for 45 minutes (warning) or 90 minutes (critical);
- snapshot pointer older than the newest accepted source run;
- snapshot build failure;
- web container restart loop;
- EBS usage above 75% or inode exhaustion;
- MySQL pool/query timeout errors;
- required Redis health failures or sustained eviction churn;
- sustained API p95 above 500 ms.

Do not expose the operations token in a monitoring URL.

## 14. Backups and disaster recovery

RDS MySQL is the source of truth. Enable managed point-in-time recovery and database
snapshots according to the data-team retention policy.

Redis values are rebuildable read accelerators, not database backups. Do not treat
them as a substitute for RDS backups.

Back up:

- RDS data and versioned view definitions;
- secret-manager values and environment templates;
- container image digests and deployment configuration;
- Caddy configuration.

During recovery, recreate the EC2/Docker deployment, restore RDS when required, and
rebuild the current Redis traffic cache from MySQL.

## 15. Rollback

Rollback changes the web container to the previous compatible immutable image
digest:

1. Update the web deployment image reference to the previous release digest.
2. Pull and recreate the web container.
3. Do not flush Redis during the web rollback.
4. Run the health and snapshot smoke tests.

Do not destructively roll back database views. Serving-view changes must remain
compatible with at least one previous application release.

If a newly built traffic version is invalid, leave the current Redis pointer on the
previous version and rebuild from MySQL.

## 16. Scale-out triggers and future architecture

Remain on one web container, one worker container, and one EC2 instance until
one of these is sustained:

- CPU above 65%;
- memory above 75%;
- API p95 above 500 ms after query/index optimization;
- database connections approach the planned ceiling;
- availability requirements demand instance redundancy.

Before adding replicas:

1. Confirm Redis capacity and throughput for shared dashboard and tile reads.
2. Consider publishing immutable vector tiles to object storage/CDN if Redis
   network or memory usage becomes the limiting factor.
3. Move rate limiting and distributed locks to the existing Redis/ElastiCache
   service or an edge gateway.
4. Add a load balancer and health checks.
5. Confirm every replica observes the same source version before announcing it.

All application cache data is already shared through Redis; the remaining scale-out
work is rate limiting, coordination, and load balancing.
