# Gravity-here-v2 catchment serving and production cutover

Status: v2 database activated; public application rollout pending the
post-activation scheduled-run gate. Last reviewed: 30 July
2026.

## Safety contract

The application supports two independent v2 access modes:

- authorized internal preview through
  `mobility_catchment_shadow_ui_enabled`;
- public production serving through
  `mobility_catchment_v2_public_enabled`.

Every successful public read enforces all of these conditions:

- model version is `gravity-here-v2`;
- model version is active;
- latest-run status is `success`;
- database public serving is true;
- modeled zone count is 21;
- directed OD pair count is 420;
- input coverage is at least 0.90;
- run error JSON is null;
- the public application flag is enabled.

The database readiness signal is not the rollout flag. Both are required.
The internal flag can remain enabled whether public serving is off or on.
Public v2 handlers query only the versioned catchment views. Legacy
nine-area handlers remain separate for application rollback.

## MVP access

All internal routes evaluate `MOBILITY_CATCHMENT_SHADOW_UI_ENABLED`. When
disabled, the route returns 404 so the preview surface is not advertised. The
MVP intentionally has no catchment-preview login, session cookie, role, or
bearer-token exchange. Rate limiting and the read-only database boundary
remain in place.

All public v2 routes evaluate `MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED`. When
disabled, they return 404. When enabled, they still return 503 unless the
latest database row satisfies the complete public v2 contract.

Public endpoints:

```text
GET /api/v1/mobility/catchments/overview
GET /api/v1/mobility/catchments/zones
GET /api/v1/mobility/catchments/flows
GET /api/v1/mobility/catchments/centers
```

## Serving behavior

Latest metadata is cached for no longer than 30 seconds. Zones are cached by
model run; flows by run, origin, destination, score, and limit; centers by run
and category. Old run-scoped cache entries are removed when a new latest run
is accepted. Responses have private ETags and allow transport compression
through `Vary: Accept-Encoding`.

The mobility view loads the full 420-pair directed matrix. DPS Airport Gateway
remains in the focus list and can be selected like every other modeled
catchment. If a new model run becomes current between the initial resources
and the flow request,
the browser clears the short-lived preview cache and resynchronizes the
snapshot instead of leaving an empty map.

The unfiltered flow API defaults to the complete `minScore=0&limit=420`
directed matrix. The browser validates that this matrix, the overview, and the
zones all have the same latest model run, then performs presentation filtering
locally. Selecting a catchment can show its 20 outbound records, its 20 inbound
records, or both without generating reverse arrows. The visible map then
applies the greater-than-1% predicted share-from-origin rule and the selected
confidence threshold.

Traffic guidance changes only the intermediate line geometry. Every rendered
route starts at the authoritative `origin_*` coordinates and ends at the
authoritative `destination_*` coordinates. Animated arrows move in that
direction, and a fixed arrowhead marks the destination endpoint. Flow details
explicitly show From, To, relative mobility score, predicted share from the
origin, estimated duration and distance, confidence, and prediction time.

The mobility source selector uses provider-neutral labels:

- `Tourism catchments — v2 preview`
- `Regency/city — live v1`
- `Places heatmap — display only`

The tourism selection displays all 22 polygons and persistent, clickable
catchment-center name markers. Exactly 21 polygons receive the selected v2
prediction scale. Nusa Penida remains neutral. The Places selection
renders a relative heatmap from the approved aggregated activity-center
summaries and reuses the catchment outlines as neutral geographic context. It
never applies the mobility-prediction legend or describes source evidence as
movement. The Regency/city selection retains the existing nine-area v1
behavior.

Nusa Penida is checked by key as the sole display-only polygon. Its prediction,
rank, and confidence values must all remain null. The UI gives it neutral
outline styling and the label:

> Display only — road Matrix prediction unavailable

## Production cutover checklist

1. Keep `MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED=false`.
2. Grant the SELECT-only backend account access to the v2 serving views.
3. Confirm the database has exactly one active model:
   `gravity-here-v2`, with `public_serving_enabled = 1`.
4. Wait for a scheduled production run newer than the activation smoke run.
   Run IDs are supplied as evidence at execution time and are never stored:

   ```bash
   npm run release:gate:mobility-v2 -- --after-model-run-id <activation-run-id>
   ```

5. Enable `MOBILITY_CATCHMENT_V2_PUBLIC_ENABLED=true`, set its actor, deploy
   the web and worker services, and verify all five public endpoints.
6. Confirm the UI shows 22 polygons, 21 predictions, and 420 directed OD pairs.
7. Run `npm test`, `npx tsc --noEmit`, and `npm run build`.

If deployment cannot proceed, keep the public application flag false. Follow
the automation-owned `step-09-g3-rollback-gravity-v2-to-v1.sql` procedure to
restore v1; do not leave a generic active-model query connected to nine-area
application assumptions.
