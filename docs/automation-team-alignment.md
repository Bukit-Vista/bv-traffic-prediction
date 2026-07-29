# Bali Mobility — automation-team alignment

## Document status

This is the canonical implementation handoff between the product/application team
and the data-automation team for the HERE-only MVP.

Last reviewed: 29 July 2026. The dated database counts in section 4 remain audit
evidence from 16 July rather than current operational metrics. For the deployed
application topology, Redis worker, and implemented feature catalog, use
[application-architecture.md](application-architecture.md).

It translates the agreed scope into workflow schedules, database contracts,
handoff events, failure rules, ownership, and acceptance evidence. The broader
population-oriented plan remains a future reference and is not an MVP dependency.

## 1. Purpose

Align the HERE collectors, MySQL persistence, mobility worker, backend APIs, and web
dashboard around one reproducible 30-minute analytical timeline.

The intended runtime boundary is:

```text
HERE APIs
  → n8n collection workflows
  → normalized MySQL source tables
  → mobility worker
  → MySQL prediction tables
  → snapshot worker / Redis materialized cache
  → /api/v1 and internal feature-gated APIs
  → Bali dashboard
```

The browser never connects directly to HERE or MySQL. The dashboard backend uses a
read-only database account. Automation and worker processes use separately scoped
write credentials.

## 2. Product goal

Deliver a Bali dashboard that:

1. Shows measured HERE road traffic on real road geometry.
2. Monitors selected routes with current, typical, and base travel times.
3. Predicts relative zone activity, inbound/outbound pressure, and OD strength.
4. Uses HERE Places for destination attraction.
5. Uses HERE Matrix Routing for zone-to-zone travel cost.
6. Refreshes on exact 30-minute UTC buckets.
7. Reports source freshness, coverage, and partial/failed runs honestly.
8. Retains the previous successful result when a new run fails.

Mandatory product statement:

> Predicted relative mobility index derived from HERE traffic, routing, places and
> accessibility data. This is not an observed people count.

## 3. Agreed MVP boundaries

### Included

- HERE Traffic Flow API v7.
- HERE Routing API v8 for selected monitored routes.
- HERE Geocoding and Search for Places/activity centers.
- HERE Matrix Routing for bounded zone travel costs.
- Nine Bali regency/city mobility zones.
- HERE-derived relative mobility predictions.
- Current and historical route performance.
- Collector and model health.

### Optional or disabled initially

- HERE incidents may remain collected for history, but the dashboard layer and
  first model can disable incidents.
- When disabled, the model receives `incidentPenalty = 0`.
- Existing incident history must not be deleted as part of UI cleanup without a
  separate retention decision.

### Not included

- Population data.
- Actual people or vehicle counts.
- Observed OD trips.
- Device or visitor counts.
- Demographic or individual movement data.
- OSM POIs as production analytical inputs.

OpenStreetMap may remain an approved basemap or checked-in geographic reference
with attribution. Production Places and travel-cost inputs must come from entitled
HERE products.

## 4. Current verified state

Database audit performed on 16 July 2026:

| Capability | State |
| --- | --- |
| MySQL 8.0.44 connection | Working |
| HERE road segments | Present |
| HERE traffic observations | Present; 120,732 rows at latest audit |
| Latest traffic observation | `2026-07-16 08:29:17 UTC` |
| Flow collection runs and snapshots | Present |
| Route configuration and samples | Present; 507 live samples |
| Latest route bucket | `2026-07-16 08:00:00 UTC` |
| Incident source tables | Present, optional for MVP |
| HERE Places pipeline | Missing |
| HERE Matrix pipeline | Missing |
| Mobility worker and persisted predictions | Missing |

Present source tables:

- `traffic_collection_areas`
- `traffic_flow_collection_runs`
- `traffic_flow_snapshots`
- `traffic_road_segments`
- `traffic_flow_observations`
- `routes`
- `ingestion_runs`
- `route_samples`
- `traffic_incident_snapshots`
- `traffic_incidents`

Missing required MVP tables:

- `traffic_flow_latest`
- `route_sample_geometries`
- `here_place_import_runs`
- `here_place_snapshots`
- `here_places`
- `activity_centers`
- `matrix_collection_runs`
- `mobility_zone_travel_costs`
- `mobility_zones`
- `mobility_zone_road_segments`
- `mobility_model_versions`
- `mobility_model_runs`
- `mobility_zone_features`
- `mobility_zone_predictions`
- `mobility_od_predictions`

Optional missing tables:

- `traffic_flow_subsegment_observations`
- `traffic_incident_geometries`

## 5. Shared time and identity contract

All teams must use the same terms:

| Term | Meaning |
| --- | --- |
| `collection_slot_utc` | Exact internal bucket aligned to `:00` or `:30` |
| `source_updated_utc` | Raw HERE source-update timestamp |
| `fetched_at_utc` | Time the collector received the response |
| `prediction_for_utc` | Model bucket; must equal the source collection slot |
| `run_id` | Database identity for one collector or model execution |
| `run_token` | Stable idempotency key for a workflow and slot |

Rules:

1. Store UTC in MySQL and APIs; render WITA in the UI.
2. Never use `source_updated_utc` as the internal slot identity.
3. Never replace a requested bucket with the current time.
4. Re-running the same workflow and slot must be idempotent.
5. A provider timestamp may repeat across slots without collapsing history.
6. Automation must pass the exact source run ID to the mobility worker.

Recommended run tokens:

```text
flow:2026-07-16T08:30:00Z
routes:2026-07-16T08:35:00Z
places:2026-07
matrix:zone-v1:2026-07-16
model:gravity-here-v1:2026-07-16T08:30:00Z
```

## 6. Target workflow schedule

Workflow timezone must be declared explicitly as `Asia/Makassar`. Persisted bucket
values remain UTC.

| Workflow | Recommended schedule | Notes |
| --- | --- | --- |
| HERE Flow | `:00` and `:30` | Primary analytical clock |
| HERE Routes | `:05` and `:35`, or hourly | Sequential requests; quota dependent |
| HERE Incidents | `:08` and `:38`, when retained | Optional, not a model blocker |
| Mobility worker | Triggered after Flow Finalize | Receives exact flow run and slot |
| HERE Places | Monthly or allowed refresh | Respect entitlement and retention |
| HERE Matrix baseline | Daily or zone-version change | All bounded zone pairs |
| HERE Matrix live refresh | Every 30–60 minutes if entitled | Important pairs only |

Every workflow must finish or time out before its next scheduled execution. Prevent
overlap for the same workflow and logical slot.

## 7. Workflow A — HERE Flow

### Trigger input

```json
{
  "collectionSlotUtc": "2026-07-16T08:30:00Z",
  "intervalMinutes": 30,
  "runToken": "flow:2026-07-16T08:30:00Z"
}
```

### Required execution

1. Claim or resume the run token.
2. Load active collection areas.
3. Request each bounded HERE area.
4. Store response metadata and approved raw payload/audit reference.
5. Normalize stable road-segment identities and geometry.
6. Normalize one observation per segment and collection slot.
7. Finalize run counts and status.
8. Update latest pointers for successfully collected segments.
9. Trigger the mobility worker with the finalized run ID and slot.

### Required observation contract

`traffic_flow_observations` must add:

```text
collection_slot_utc DATETIME NOT NULL
source_updated_utc  DATETIME NULL
```

Required uniqueness:

```sql
UNIQUE KEY uq_flow_observation_segment_slot (
    segment_id,
    collection_slot_utc
)
```

The existing `UNIQUE(segment_id, observed_at_utc)` does not satisfy the contract and
must be migrated. Preserve the original provider time separately.

### Latest pointer contract

```text
traffic_flow_latest
  segment_id       PK/FK -> traffic_road_segments.id
  observation_id   UNIQUE/FK -> traffic_flow_observations.id
  observed_at_utc
  updated_at_utc
```

Update latest pointers in the same bounded transaction as successful observation
persistence. A partial run updates collected segments and preserves the previous
pointer for failed areas.

### Completion event

```json
{
  "event": "traffic-flow.finalized",
  "flowRunId": 12345,
  "collectionSlotUtc": "2026-07-16T08:30:00Z",
  "status": "success",
  "expectedAreaCount": 2,
  "successfulAreaCount": 2,
  "segmentCount": 3776,
  "observationCount": 3776,
  "inputCoverage": 1
}
```

`success` and `partial` events may trigger a model run. `failed` events must not
generate credible placeholder predictions.

## 8. Workflow B — selected HERE Routes

`routes` contains approved monitored corridors. Route Performance reads only
active definitions where `route_purpose = 'airport_tourism'`. These are different
from the nine zone-to-zone Matrix relationships.

The production analytical set is seven DPS Airport ↔ tourism-center corridor
pairs: Canggu, Ubud, Uluwatu, Seminyak, Sanur, Jimbaran, and Nusa Dua. The two
directions are separate measurements. Automation must set `route_group_key`,
`tourism_center_key`, and `route_direction` (`from_airport` or `to_airport`) on
every definition; the application never averages a pair or fills one direction
from the other.

This dataset measures HERE route travel conditions. It does not observe people,
tourists, vehicles, or trip counts.

### Required corrections

1. Replace hourly sample identity with an exact collection slot.
2. Enforce `UNIQUE(route_id, collection_slot_utc)`.
3. Store actual fetch time separately.
4. Store current, typical, and base durations explicitly.
5. Calculate delay and ratio against both typical and base values.
6. Decode every valid HERE Flexible Polyline section.
7. Persist section order and valid SRID 4326 route geometry.
8. Process active routes sequentially with bounded delay.
9. Honor `Retry-After` and use bounded exponential retry for HTTP 429.
10. Preserve `route_id` through every n8n item; do not correlate by array index.
11. Select definitions with `active = 1 AND route_purpose = 'airport_tourism'`.
12. Report `route_expected_count = 14`, one result per directional definition.

### Airport-tourism activation gate

Before enabling the route view, the latest database state must show 14 active
airport-tourism definitions, seven distinct group keys, seven definitions in each
direction, a successful 14/14 `n8n-here-routes` run with zero failures, and latest
SRID 4326 geometry for all 14 routes. Application code validates this through
`GET /api/v1/ops/source-contract`; deployment also controls the view with
`AIRPORT_TOURISM_ROUTES_ENABLED`.

Recommended sample identity:

```text
route_id
collection_slot_utc
sampled_at_utc
```

Recommended route geometry:

```text
route_sample_geometries
  id
  route_sample_id
  section_index
  encoded_polyline
  geometry LINESTRING NOT NULL SRID 4326
  created_at_utc
  UNIQUE(route_sample_id, section_index)
```

## 9. Workflow C — HERE Places

Before implementation, confirm Geocoding and Search entitlement, quota, caching,
retention, attribution, and allowed raw-payload storage.

### Required tables

- `here_place_import_runs`
- `here_place_snapshots`
- `here_places`
- `activity_centers`

### Initial category groups

- Airports, ports, bus terminals, and transport hubs.
- Accommodation.
- Food and nightlife.
- Shopping.
- Tourism, attractions, and beaches.
- Hospitals and healthcare.
- Education.
- Public services.
- Business and commercial centers.

### Required place values

```text
HERE place ID
title/name
HERE category ID and name
normalized model category
address metadata
position and access position
fetch/import timestamp
source product/version
assigned mobility zone
raw object or approved audit reference
active state
base attraction weight
```

Imports must be versioned and idempotent. A new import may deactivate missing
places only under an agreed reconciliation policy; it must not silently delete
history used by an existing model version.

## 10. Workflow D — HERE Matrix Routing

Before implementation, confirm Matrix Routing entitlement, quota, billing, traffic
mode, maximum matrix size, caching, and retention.

The MVP uses nine zones, producing at most 72 directional non-self relationships.

### Required tables

- `matrix_collection_runs`
- `mobility_zone_travel_costs`

### Required values

```text
origin_zone_id
destination_zone_id
zone_version
calculation/departure bucket
duration_seconds
distance_meters
routing mode
traffic mode
matrix status/error code
fetched_at_utc
expires_at_utc
source/audit reference
```

### Failure policy

- Prefer a valid recent cached cost when a pair fails.
- Record the fallback age and lower model confidence.
- Never invent a live duration.
- Record an explicit missing relationship when no acceptable cached value exists.

## 11. GIS preparation — zones and road mapping

### Mobility zones

Import nine Bali regency/city zones for the first release.

Required schema behavior:

- `geometry MULTIPOLYGON NOT NULL SRID 4326`.
- Stable zone key and version.
- Representative centroid or point-on-surface.
- No required population field.
- All nine geometries valid and compatible with the approved Bali boundary.

The current migration uses `POLYGON` and must be revised before import.

### Zone-road mapping

Populate `mobility_zone_road_segments` with:

```text
zone_id
segment_id
overlap_meters
aggregation_weight
mapping_version
```

Every in-scope segment must map to a zone or have a documented exclusion reason.
The mapping is precomputed and must not be built during an API request.

## 12. Mobility worker handoff

n8n should orchestrate the worker, not execute one SQL operation per zone or OD
pair.

### Worker request

```json
{
  "flowRunId": 12345,
  "collectionSlotUtc": "2026-07-16T08:30:00Z",
  "sourceStatus": "success",
  "sourceCoverage": 1,
  "requestedModelVersion": "gravity-here-v1"
}
```

### Worker behavior

1. Validate that the supplied run and slot match MySQL.
2. Claim `(prediction_for_utc, model_version_id)` idempotently.
3. Read zones, zone-road mappings, slot-specific flow observations, HERE Places,
   activity-center weights, and cached Matrix costs.
4. Set `incidentPenalty = 0` for the initial version.
5. Compute traffic-derived origin activity; do not use population potential.
6. Compute destination pull from HERE Places and accessibility.
7. Apply travel impedance from cached HERE Matrix duration.
8. Produce zone features, zone predictions, and OD predictions.
9. Validate score, confidence, coverage, and share constraints.
10. Commit bounded batches and finalize run status.

### Required result tables

- `mobility_model_versions`
- `mobility_model_runs`
- `mobility_zone_features`
- `mobility_zone_predictions`
- `mobility_od_predictions`

The current calculation library and migration still use `populationPotential`.
Application engineering must revise them to use HERE-derived
`origin_activity_score` before production execution.

## 13. Status and failure semantics

All collector and model workflows use:

```text
running | success | partial | failed
```

Rules:

- `success`: all required inputs were collected and validated.
- `partial`: usable output exists with reduced coverage.
- `failed`: no credible current output can be produced.
- Partial source inputs reduce prediction confidence.
- Failed model runs retain the previous successful prediction.
- Error metadata is redacted before reaching public APIs.
- Raw provider payload access remains restricted and auditable.
- Current-data unavailability returns `503` plus last-success metadata, not a
  believable empty success response.

## 14. Rate, retry, and database controls

- Declare workflow timezone.
- Prevent overlapping executions.
- Set a timeout below the next scheduled interval.
- Stagger Flow, Routes, and optional Incidents.
- Use sequential route calls and bounded area concurrency.
- Honor HERE `Retry-After`.
- Use bounded exponential retry with jitter.
- Chunk database writes sequentially.
- Do not open one MySQL connection per item, zone, or OD pair.
- Cap raw JSON size; store an approved external URI/checksum when oversized.
- Record HTTP status, provider tracking ID, response bytes, retry count, and elapsed
  time in operations metadata.

## 15. Security and configuration boundary

Automation team owns:

- HERE server credentials.
- Collector/write MySQL credentials.
- Secret storage and rotation.
- Provider quota monitoring.
- Restricted raw-payload storage.

Application team owns:

- Read-only MySQL credentials.
- Public API authorization and validation.
- Redacted error responses.
- Map/API caching and feature limits.

Never place HERE credentials in browser-exposed environment variables or return
them through workflow error payloads.

## 16. Ownership and deliverables

| Deliverable | Automation/data team | Application team |
| --- | --- | --- |
| Exact flow slots and lineage | Own | Validate/read |
| Transactional latest pointers | Own | Query |
| Route cadence, pacing, and geometry persistence | Own | Decode helper/display/API |
| HERE Places imports | Own | Categories, weights, API/display |
| HERE Matrix cost cache | Own | Candidate needs and consumer contract |
| Nine-zone import and road mapping | Own with GIS | Validate/render |
| Model trigger | Own | Worker endpoint/job |
| Model algorithm and database worker | Support inputs | Own implementation |
| Collector/model run metadata | Own writes | Own health UI/API |
| SQL/API spatial queries | Support indexes | Own queries |
| UI latest/history behavior | — | Own |

### Automation-team evidence package

For each production workflow, provide:

- exported version-controlled n8n JSON;
- workflow name, version, owner, and timezone;
- schedule and maximum expected duration;
- redacted environment-variable inventory;
- source product and entitlement confirmation;
- run-token/idempotency rule;
- target tables and uniqueness constraints;
- retry, timeout, overlap, and partial-failure rules;
- example successful, partial, retried, and failed executions;
- row-count reconciliation between provider response and MySQL;
- rollback or disable procedure;
- dashboard/alert location for failures.

## 17. Application corrections completed after the baseline audit

The automation pipeline cannot make the dashboard live by itself. The following
items were identified by the baseline audit and have since been implemented:

1. Replace the geographic-SRID `ST_MakeEnvelope` query with a valid prepared WGS84
   polygon predicate.
2. Replace the failing prepared `LIMIT ?` usage with an already validated bounded
   integer in SQL.
3. Follow `latest` automatically until the user selects history.
4. Load overview, slots, routes, run health, and map layers from MySQL rather than
   retaining demo fixture values.
5. Feature-flag or remove incident API requests when incidents are disabled.
6. Revise the gravity model and schema to remove population dependency.
7. Return `503` and last-success metadata for unavailable current data.
8. Add production-database contract and smoke tests.
9. Add Redis JSON caching, immutable traffic snapshots, and vector tiles.
10. Add the aligned snapshot worker and browser-side automatic version polling.

Remaining production-hardening work is tracked in
[cloud-deployment-runbook.md](cloud-deployment-runbook.md), including
CA-validated RDS TLS, shared rate limiting before web scale-out, and worker
heartbeat monitoring.

## 18. Delivery sequence

1. Confirm HERE Search and Matrix entitlements and retention terms.
2. Confirm OSM basemap/boundary approval as cartographic context.
3. Back up MySQL and agree on a revised migration.
4. Correct Flow and Route slot identity and uniqueness.
5. Add overlap, timezone, rate, retry, and timeout controls.
6. Create and maintain `traffic_flow_latest`.
7. Persist decoded route geometry and explicit duration semantics.
8. Repair application live traffic SQL and latest behavior.
9. Apply the revised HERE-only mobility schema.
10. Import/version nine `MULTIPOLYGON` zones.
11. Import HERE Places and activity centers.
12. Build/version zone-road mappings.
13. Build the HERE Matrix travel-cost cache.
14. Seed and activate `gravity-here-v1`.
15. Implement the mobility worker and Flow Finalize trigger.
16. Enable live mobility APIs and UI behind a feature flag.
17. Run at least three consecutive days of parallel validation.
18. Complete product, data, security, and operations sign-off.

## 19. Acceptance checklist

### Source collection

- [ ] Flow runs exist exactly at `:00` and `:30`.
- [ ] Route samples no longer overwrite within an hour.
- [ ] Provider update time and internal collection slot are separate.
- [ ] Re-running a slot does not duplicate or move history.
- [ ] Workflow overlap is prevented.
- [ ] Route collection is paced and handles HTTP 429.
- [ ] Airport-tourism definitions form seven complete directional pairs (14 routes).
- [ ] Latest `n8n-here-routes` run is successful for 14/14 routes with zero failures.
- [ ] All 14 latest directional samples have SRID 4326 geometry.
- [ ] Latest pointers preserve unaffected segments during partial runs.

### HERE-only inputs

- [ ] Search and Matrix entitlements are confirmed.
- [ ] All nine zone geometries are valid `MULTIPOLYGON` SRID 4326.
- [ ] HERE Places imports are versioned and categorized.
- [ ] Every road has a zone mapping or exclusion reason.
- [ ] Every retained OD pair has a current or acceptable cached travel cost.
- [ ] No population input is required by the active model version.

### Predictions

- [ ] One idempotent model run exists per flow slot and active version.
- [ ] Every run records exact source IDs and input versions.
- [ ] Scores remain between 0 and 100.
- [ ] Confidence remains between 0 and 1.
- [ ] Predicted shares reconcile per origin.
- [ ] Partial inputs reduce confidence and remain visibly partial.
- [ ] Failed runs retain the previous valid layer.

### Application and operations

- [ ] Main dashboard values come from MySQL, not demo fixtures.
- [ ] Latest mode advances automatically.
- [ ] Historical mode remains pinned intentionally.
- [ ] Live viewport APIs use bounded spatial queries.
- [ ] Optional incident failures cannot block traffic/mobility refresh.
- [ ] Every screen displays correct measured/predicted semantics.
- [ ] Operations exposes run freshness, coverage, retries, and failures.
- [ ] Three consecutive days meet freshness, coverage, rate, and connection targets.

## 20. Completion criterion

The automation/application integration is ready for production only when the
acceptance checklist is signed by the automation owner, application owner, database
owner, product owner, and security/operations owner.

Collection alone is not completion. The project is achieved when source lineage,
HERE-only model inputs, prediction runs, APIs, map behavior, and operational health
all use the same exact slot and version contracts.
