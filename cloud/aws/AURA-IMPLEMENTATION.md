# AURA local implementation and reviewed deployment

## Status and contracts

AURA is an additive Serverless service. It does not edit Supervisor or deploy AWS resources. Operations is a prerequisite because AURA reads its incidents and maintenance orders. No Z3 code/package/contract was found locally; assignment uses the repository Hungarian solver.

The OpenAPI 3.1 contract is packages/contracts/openapi/aura.v1.yaml. Responses use the existing {data: ...} envelope. Tenant identity is resolved from verified Cognito subject and membership. Request bodies do not accept tenantId.

| Method and path | Purpose |
| --- | --- |
| GET/POST /technicians | List profiles; create or versioned replace |
| GET/PATCH /technicians/{technicianId} | Read or soft archive (If-Match) |
| PUT /machines/{machineId}/coordinates | Set verified WGS84 coordinates |
| GET/POST /inventory/parts | Catalog and part creation |
| GET /inventory/stock, GET /inventory/alerts | Balances and observed low-stock alerts |
| GET/POST /inventory/movements | Movement history and idempotent adjustment |
| POST /maintenance/orders/{workOrderId}/reservations | Reserve using an idempotency key |
| POST /inventory/reservations/{reservationId}/release | Release idempotently |
| POST /assignments/optimize | Hungarian assignment and workflow dispatch |
| GET /assignments, GET /assignments/{assignmentId} | Assignment and cost explanation |
| POST /assignments/{assignmentId}/response | Human confirmation or intervention completion |
| GET/PUT /assignments/policy | Versioned tenant policy |
| GET /operations/kpis?from=...&to=... | Period-bounded MTTR, recurrence, SLA, downtime |
| GET /aura/events | Persisted AURA event history |

Example technician:

    {"technicianId":"tech-042","displayName":"Elena Rojas","specialties":["hydraulics"],"skills":[{"code":"hydraulic-diagnostics","level":4}],"availability":"available","maxConcurrentAssignments":2,"shifts":[{"daysOfWeek":[1,2,3,4,5],"startTime":"08:00","endTime":"17:00","timeZone":"America/Lima"}],"coordinates":{"latitude":-12.0464,"longitude":-77.0428,"datum":"WGS84"},"cognitoSub":"user-pool-subject"}

Example optimization:

    POST /assignments/optimize
    Authorization: Bearer <Cognito access token>
    Idempotency-Key: demo-assignment-2026-01
    Content-Type: application/json

    {"incidentIds":["incident-101","incident-102"],"requirements":{"incident-101":[{"code":"hydraulic-diagnostics","minLevel":3}]}}

The response includes normalized cost components and distanceKm only when both verified WGS84 coordinates exist; it never infers travel time. Skills, availability, shift and capacity are eligibility constraints. No eligible technician means unassigned. Reuse the same idempotency key after an uncertain dispatch response.

Callback examples:

    {"phase":"confirmation","decision":"accepted"}
    {"phase":"intervention","occurredAt":"2026-11-15T17:10:00Z","notes":"Replaced the filter and verified pressure"}

Callback tokens are never part of HTTP routes/responses. Backend stores them with TTL and uses SendTaskSuccess after validating tenant and actor. Every wait is finite. NotificationRequested proves persistence only; no delivery provider exists.

## DynamoDB

AURA owns a separate on-demand table with Retain policies, point-in-time recovery and TTL:

- pk = TENANT#{tenantId}; sk = AURA#{entityType}#{entityId}.
- ByTenantType GSI: gsi1pk = TENANT#{tenantId}#TYPE#{entityType}; gsi1sk = {createdAt}#{entityId}.
- expiresAt TTL is used for idempotency/callback records; TTL deletion is asynchronous.
- Entity types include technician, machine location, part, stock, movement, reservation, assignment, callback, event, idempotency and policy.

Stock movement/reserve/release/consume use conditional transactions in AURA. Operations incident/work-order updates use the existing versioned update-with-event repository. These tables are not cross-table atomic; retries are idempotent, but a failure between updates may require repair. Queries are paginated by GSI; no table scans are introduced.

## Authorization and IAM

All routes use existing Cognito JWT scopes and tenant membership resolution. Operator is required for assignment/inventory operations; admin for catalog/policy/location changes. Callback response is limited to the assigned Cognito subject or tenant admin/owner.

serverless.aura.yml references external role ARNs and creates no IAM roles:

| Variable | Minimum access |
| --- | --- |
| AURA_READ_ROLE_ARN | Get/Query on tenant, machine, Operations, AURA tables and indexes |
| AURA_WRITE_ROLE_ARN | Read plus conditional Put/Update/TransactWrite on AURA |
| AURA_ADMIN_ROLE_ARN | AURA writes plus required reads; no IAM/SFN control |
| AURA_CALLBACK_ROLE_ARN | AURA/Operations reads and updates plus states:SendTaskSuccess on * |
| AURA_WORKFLOW_ROLE_ARN | AURA/Operations record access needed by worker handlers |
| AURA_STEP_FUNCTIONS_ROLE_ARN | lambda:InvokeFunction restricted to AURA workflow handlers |

Keep SendTaskSuccess in the callback role because IAM requires Resource *. Do not give it to a broad LabRole if a scoped role is possible. AWS Academy policies, deployed route inventory and CloudFormation ownership are unavailable in this local session; verify before any change set. Stop if role permissions or route ownership are unknown.

No Render/Gemini secret is added. Supervisor remains unchanged; AURA assignment is deterministic and does not let an AI execute critical actions.

## Variables and hosting

Backend shell/session: AWS_ACCOUNT_ID, AWS_REGION=us-east-1, STAGE, HTTP_API_ID, HTTP_API_AUTHORIZER_ID, MACHINES_TABLE, TENANTS_TABLE, OPERATIONS_TABLE, AURA_TABLE, COGNITO_ISSUER, COGNITO_AUDIENCE, WEB_ORIGIN, and the six role ARNs above. AURA_TABLE defaults to arquifusion-aura-<stage>. Keep values in the approved shell/credential chain, not git.

Cloudflare Pages:

- Root directory: / (monorepo root); install: npm ci.
- Build: npm run build --workspace @arquifusion/frontend.
- Output: apps/frontend/dist.
- SPA fallback: apps/frontend/public/_redirects contains /* /index.html 200.
- Public variables: VITE_API_URL=https://ep40dq915l.execute-api.us-east-1.amazonaws.com, VITE_AUTH_MODE=cognito, VITE_COGNITO_CLIENT_ID, VITE_COGNITO_DOMAIN, VITE_COGNITO_REDIRECT_URI=https://arquifusion-corp.pages.dev/auth/callback.

Cognito client ID and Hosted UI domain are public settings. Never put API/Gemini credentials or server secrets in VITE_ variables. No .env file is required or added.

## Reviewed deployment steps

1. Review git diff. In AWS verify account/region, HTTP API route conflicts, Cognito authorizer, table ownership/drift, IAM role policies and Step Functions callback permissions.
2. In Linux/Ubuntu run:

       npm ci
       npm run test --workspace @arquifusion/backend
       npm run validate:infra --workspace @arquifusion/backend
       npm run build --workspace @arquifusion/frontend

3. Authenticate Serverless Framework v4 in the approved account and provide AWS Academy credentials through its shell credential chain. Package without deployment:

       npx serverless package --config cloud/aws/serverless.operations.yml --stage dev --region us-east-1
       npx serverless package --config cloud/aws/serverless.aura.yml --stage dev --region us-east-1

   Serverless v4/esbuild bundles the TypeScript handlers and runtime dependencies per function. Operations now uses source handlers and bundle config so @langchain/langgraph is not expected as an unresolved runtime import. Review ZIPs and CloudFormation templates. If v4 authentication or Academy permissions block package, report it unverified; do not copy all node_modules.
4. Review/deploy Operations first so its table and routes exist. Supervisor is already deployed and is not part of this change.
5. Review AURA's retained table, additive API routes, external IAM roles and separate Standard state machine. Deploy only after human review.
6. Smoke-test 401/403, routes, reservation concurrency, idempotency replay, callback acceptance/rejection/expiry, event persistence and terminal workflow state. Verify tokens never appear in browser traffic or logs.
7. Review Pages variables, output and Cognito callback/logout origins. No AWS, Render, or Cloudflare deployment was done.

## Five-minute pitch after reviewed deployment

Use a test tenant and test records:

1. 0:00–0:40 — Cognito login, live API health and fleet KPIs.
2. 0:40–1:25 — Open a real test incident/work order and show telemetry evidence/history.
3. 1:25–2:10 — Show technicians, shifts, skills and verified locations; select eligible incidents and run optimizer once.
4. 2:10–3:00 — Explain global cost, hard eligibility and omitted distance when coordinates are missing.
5. 3:00–3:45 — Assigned test technician accepts, then submits intervention timestamp and notes; show callback progression.
6. 3:45–4:25 — Reserve a test part; show on-hand/reserved/available and same-key idempotent retry.
7. 4:25–5:00 — Show audit timeline and period KPIs; explicitly identify unavailable downtime/SLA and distinguish persisted notification from delivery.

## Risks pending

- AWS Academy permissions, live routes and CloudFormation ownership remain unverified.
- Operations and AURA are not deployed; modules show explicit unavailable state until deployment.
- No delivery provider exists; only notification request events persist.
- Downtime lacks machine stop/return timestamps; SLA stays unavailable until configured; recurrence uses 30 days.
- Operations and AURA are separate tables and not one cross-table transaction.
- ZIP size/import checks need authenticated Serverless v4 packaging on Linux. No deployment or AWS integration test was performed.
