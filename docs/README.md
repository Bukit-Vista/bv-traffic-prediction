# Documentation Index

Last reviewed: 29 July 2026

This index identifies the current runtime contracts and separates them from
dated implementation handoffs or incident records.

## Current runtime documentation

| Document | Purpose |
| --- | --- |
| [Application architecture and feature guide](application-architecture.md) | Canonical description of the archetype, code style, features, data flows, caching, automatic updates, and runtime components |
| [Oxman–Krebs development reconstruction](oxman-krebs-development-report.md) | Evidence-based rewind and replay of the application's development through Science, Engineering, Design, and Art/Perception |
| [OpenAPI contract](openapi.yaml) | Current public `/api/v1` HTTP surface |
| [Cloud deployment runbook](cloud-deployment-runbook.md) | Production topology, environment, release, monitoring, recovery, and scaling |
| [Development guide](development-guide.md) | Local workflow, code ownership, testing, caching, and contribution rules |
| [Redis traffic-cache runbook](traffic-snapshot-runbook.md) | Snapshot worker, immutable traffic versions, Redis limits, and recovery |
| [Gravity-here-v2 serving and cutover](step-09f-internal-catchment-preview.md) | Internal preview, public rollout gates, API contract, and rollback |

## Data and automation contracts

| Document | Purpose |
| --- | --- |
| [Automation-team alignment](automation-team-alignment.md) | Canonical ownership, source timeline, workflow, and acceptance contract |
| [Step 3 source dashboard](step-3-source-dashboard.md) | Source-serving cutover and release-gate record |

## Documentation maintenance rule

When application behavior changes:

1. Update the architecture guide and README feature summary.
2. Update `openapi.yaml` when an HTTP route or contract changes.
3. Update the deployment and snapshot runbooks when a container, environment
   variable, schedule, cache, or health check changes.
4. Update `.env.example` when runtime configuration changes.
5. Keep dated incident evidence in the incident-management system rather than
   adding it to the current application documentation.
6. Verify every documented Docker Compose command with
   `docker compose ... config --quiet`.
