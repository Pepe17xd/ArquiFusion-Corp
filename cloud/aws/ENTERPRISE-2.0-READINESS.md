# ArquiFusion Enterprise 2.0: local readiness

This document describes the current repository implementation. The Operations and AURA stacks are local additions and are **not confirmed deployed**. No AWS, Cognito, Render, or Cloudflare calls were made for this work.

## Vertical workflow present in code

The existing Operations service persists telemetry, rule-based anomalies, incidents, maintenance orders, and events. AURA now connects that data to a persisted Hungarian assignment proposal. The proposal is separate from dispatch; an administrator approves a selected eligible technician to start the independent AURA Step Functions workflow. Technicians can read only work orders assigned to the active Cognito subject's linked profile, record work, reserve or consume parts for that order, and submit completion for administrative review. The review endpoint can approve and close the linked incident or return the order to work in progress. Gemini explanation remains behind the existing intelligence provider; responses identify the provider/fallback source and never authorize a repair by themselves.

The backend remains authoritative. A verified Cognito `sub` is mapped to an active tenant membership. The `technician` membership role is accepted only by handlers that also verify work-order assignment against the active technician profile. Generic fleet, task, inventory, and tenant-wide routes reject technician memberships. `tenantId`, `role`, and `technicianId` from request bodies do not grant access.

## Added or connected HTTP contracts

All routes below use the shared HTTP API JWT authorizer and OAuth scopes from Serverless configuration. Request/response envelopes and schemas are in `packages/contracts/openapi/aura.v1.yaml` and `operations.v1.yaml`; API responses retain the existing `{ "data": ... }` envelope.

| Method and route | Use |
| --- | --- |
| `POST /tenants/{tenantId}/members` | Deprecated and disabled (409). A caller-supplied Cognito `sub` is not proof of consent; use the email invitation route below. Existing memberships continue to work. |
| `GET /technician/me` | Resolve the active profile linked to the caller's Cognito subject. |
| `GET /technician/work-orders?limit=&cursor=` | Page only the caller's assigned work orders; includes incident, machine, and active reservations. |
| `POST /technician/work-orders/{workOrderId}/analysis` | Explain the assigned order with the existing Operations intelligence provider or an explicit deterministic fallback. |
| `POST /technician/work-orders/{workOrderId}/start` | Start an assigned order. |
| `POST /technician/work-orders/{workOrderId}/block` | Block an assigned order with required notes. |
| `POST /technician/work-orders/{workOrderId}/complete` | Submit completed work and notes for admin review; does not close the incident. |
| `POST /technician/work-orders/{workOrderId}/reservations` | Reserve stock for an assigned order with an idempotency key. |
| `POST /technician/work-orders/{workOrderId}/reservations/{reservationId}/consume` | Consume a reservation for the same assigned order. |
| `POST /assignments/optimize` | Persist an AURA proposal; `dispatch:false` leaves it awaiting approval. |
| `POST /assignments/{assignmentId}/approval` | Admin confirms the recommended or another eligible technician; idempotent dispatch starts the workflow. |
| `POST /maintenance/orders/{workOrderId}/review` | Admin approves or returns a completed order; approval closes the linked incident. |
| `POST /tenants/{tenantId}/technicians/invitations` | Admin creates an invited Cognito account and links its returned `sub` to a technician profile and tenant membership. Requires `TECHNICIAN_LIFECYCLE_ROLE_ARN`. |
| `PATCH /technicians/{technicianId}` | Admin edits a versioned profile or sends `{"action":"deactivate"}` to block membership, disable the Cognito user, and globally sign out sessions. |
| `PUT /inventory/parts/{partId}` | Admin edits a part catalog record with `If-Match` version control. |
| `POST /incidents` | Admin creates a persistent manual incident with an idempotency key; no Gemini result is required. |
| `POST /incidents/{incidentId}/maintenance-orders` | Admin creates one deterministic corrective order for an incident, even without an anomaly or AI analysis. |

The pre-existing catalog, stock, movement, reservation, rules, telemetry, anomaly, incident, KPI, and event contracts remain in their existing OpenAPI documents. The AURA workflow token is stored/used by backend handlers only and is intentionally absent from the public OpenAPI schemas.

## Persistence and current query shape

- Operations table: tenant partition plus entity sort key; `ByTenantType`, `ByTenantMachine`, and additive `ByTenantAssignee` indexes. Work-order writes index assigned records by tenant and `assignedTechnicianId`, ordered by `updatedAt#entityId`.
- AURA table: tenant partition plus entity sort key; existing `ByTenantType` index. It stores technician profiles, assignment proposals/state, inventory parts/stock/movements/reservations, idempotency records, callbacks, and AURA events.
- The DynamoDB adapters use conditional versions and transactions for stock reservation/settlement; the in-memory/local adapters support deterministic tests.
- Technician work-order listing queries `ByTenantAssignee`, returning only the authenticated technician's tenant-scoped records. Existing assigned orders need the conditional backfill below before AURA's indexed code is released; unassigned or legacy records without `updatedAt` are skipped and must be reviewed.
- AURA audit filters (`from`, `to`, `eventType`, `status`, `error`, `search`) are applied by the backend before it returns a page. Opaque cursors bind to tenant and filter set. DynamoDB still reads tenant EVENT index pages and applies filters while paging; very selective queries can traverse many pages, so consider dedicated indexes if scale warrants it.

## Cognito and account provisioning

The repository's Cognito access token remains the identity proof. Tenant roles are stored in the tenant directory rather than trusted from browser fields. Invitation uses `AdminCreateUser` without a caller-supplied temporary password, so Cognito sends its configured invite. The returned Cognito `sub` is persisted in the idempotency record, technician profile, and membership; the request cannot choose a `sub`. Existing users in another tenant are rejected. Retries use the same idempotency key. If the process crashes after Cognito creates the user but before the subject is recorded, an operator must reconcile the invite before retry because Cognito may report that the username already exists.

Deactivation writes the authoritative tenant-directory disabled marker first, so the API authorizer rejects previously issued but unexpired access tokens on their next request. It then runs Cognito `AdminDisableUser` and `AdminUserGlobalSignOut`. Already-running backend requests are not forcibly terminated. The externally managed lifecycle role must permit `cognito-idp:AdminCreateUser`, `cognito-idp:ListUsers`, `cognito-idp:AdminDisableUser`, and `cognito-idp:AdminUserGlobalSignOut` scoped to the intended user pool. The handler fails closed if pool configuration is absent.

## Environment and deployment review

The frontend uses public `VITE_API_URL` when set; otherwise production defaults to the currently documented API URL and local Vite proxies `/api` to `http://localhost:3001`. Cognito values continue to come from the existing Vite environment configuration. No secret belongs in `VITE_*` variables.

The independent AURA stack consumes the existing external role and resource configuration, including `HTTP_API_ID`, `HTTP_API_AUTHORIZER_ID`, `AWS_ACCOUNT_ID`, `MACHINES_TABLE`, `TENANTS_TABLE`, `OPERATIONS_TABLE`, `COGNITO_ISSUER`, `COGNITO_AUDIENCE`, and `WEB_ORIGIN`, plus its `AURA_*_ROLE_ARN` role references. Optional `INTELLIGENCE_SERVICE_URL` enables the configured explanation provider; it must be an HTTPS endpoint and its private credential remains in the backend's existing secret configuration, never in frontend variables. The platform membership write route requires the existing `TENANT_WRITE_ROLE_ARN` policy to permit the membership-table conditional write.

Before any reviewed deploy, inspect the real HTTP API route inventory and CloudFormation stack ownership, confirm the Operations and AURA tables are not already owned elsewhere, and inspect each externally managed role policy. AURA requires DynamoDB read/query/conditional write/transact permissions over its table plus the Operations and tenant resources used by the handlers. Its callback role requires `states:SendTaskSuccess` and `states:SendTaskFailure` (AWS does not support resource scoping for these actions, so isolate the grant to the callback Lambda role). Step Functions permissions must target only the AURA state machine. No new always-on service is introduced.

### Reviewed deployment order (dev only)

1. Confirm stack/table ownership and route inventory before changing AWS. Verify `TECHNICIAN_LIFECYCLE_ROLE_ARN` is a pre-existing role scoped to the selected user pool, and contains only the four Cognito actions listed above. Verify each existing AURA role has the table permissions required by its handlers. Do not infer permissions from the `LabRole` name.
2. Build and validate locally. From the repo root run `npm.cmd run build --workspace @arquifusion/backend`, `npm.cmd run validate:infra --workspace @arquifusion/backend`, and `npm.cmd test --workspace @arquifusion/backend`.
   From `cloud/aws`, package each stack and inspect `cloudformation-template-update-stack.json`, the generated API routes, IAM role references, and ZIP contents before approving any deploy:

   ```powershell
   npx.cmd serverless package --config serverless.operations.yml --stage dev --region us-east-1
   npx.cmd serverless package --config serverless.aura.yml --stage dev --region us-east-1
   ```

   Only after confirming CloudFormation ownership, exported AWS Academy credentials, role policies, route inventory and the GSI plan, the reviewed deployment commands are:

   ```powershell
   npx.cmd serverless deploy --config serverless.operations.yml --stage dev --region us-east-1
   # Wait for ByTenantAssignee to become ACTIVE and run the guarded backfill.
   npx.cmd serverless deploy --config serverless.aura.yml --stage dev --region us-east-1
   ```

   These commands are documentation only; they were not executed. Serverless Framework v4 may require its configured authentication flow, and AWS Academy session credentials expire. Stop if packaging prompts for an unexpected account or deployment proposes replacing a shared API, table, authorizer, role, or state machine.
3. Deploy `serverless.operations.yml` to the reviewed development stack first so DynamoDB adds `ByTenantAssignee`. This is additive. Wait until `ByTenantAssignee` reports `ACTIVE` before continuing. For an explicitly selected dev table, backfill assigned existing orders with conditional writes:

   ```powershell
   $env:AURA_BACKFILL_STAGE = 'dev'
   $env:AURA_BACKFILL_CONFIRM = 'dev-only'
   $env:AURA_BACKFILL_TENANT_ID = '<development-tenant-id>'
   $env:OPERATIONS_TABLE = 'arquifusion-operations-dev'
   npm.cmd run backfill:assignee-index --workspace @arquifusion/backend
   ```

   The backfill skips unassigned/legacy rows without timestamps, checks the assigned technician and `updatedAt` did not change concurrently, and performs no deletes. Do not point it at any table without a `-dev` suffix.
4. Deploy the AURA stack to the same reviewed dev stage and API. Configure its existing role ARNs, `COGNITO_USER_POOL_ID`, tenant/table variables and authorizer ID; do not create replacement shared API or IAM resources. Operations and AURA deploy independently and keep distinct state machines.
5. Smoke test the newly deployed endpoints with an ADMIN and invited TECHNICIAN. A technician must receive 403 for general tenant incident/inventory lists and 404 for another technician's order. Confirm a Cognito invitation arrives before trying first login. Inspect CloudWatch for request IDs only; never log callback tokens or JWTs.
6. Rollback means restoring the last reviewed Operations/AURA Lambda artifact and route configuration. Keep the additive GSI and backfilled attributes; do not delete or replace tables/indexes during rollback. Recheck callback and API route ownership before retrying.

### Reproducible enterprise demo

The API seed creates three clearly labeled `DEMO-*` machines, invites two technicians, creates two parts, posts idempotent stock receipts, creates a manual incident and corrective order, then persists an AURA recommendation without dispatching Step Functions. It requires an existing development tenant and authenticated ADMIN token. Use real test inboxes for the two technician invites:

```powershell
$env:AURA_DEMO_STAGE = 'dev'
$env:AURA_DEMO_API_URL = 'https://<development-api-id>.execute-api.us-east-1.amazonaws.com/dev'
$env:AURA_DEMO_TENANT_ID = '<development-tenant-id>'
$env:AURA_DEMO_ADMIN_ACCESS_TOKEN = '<short-lived-admin-access-token>'
$env:AURA_DEMO_TECH1_EMAIL = '<technician-one-test-inbox>'
$env:AURA_DEMO_TECH2_EMAIL = '<technician-two-test-inbox>'
npm.cmd run demo:enterprise --workspace @arquifusion/backend
```

The script refuses to run unless `AURA_DEMO_STAGE=dev` and the API URL is an API Gateway URL ending in `/dev`. It contains no credentials. The output includes the recommendation and resource IDs. An ADMIN then reviews/approves a proposal in the UI; each TECHNICIAN completes Cognito's own invite and signs in to **Mis asignaciones**. The seed intentionally does not confirm assignment or start a callback workflow automatically.

Local verification:

```powershell
npm.cmd run build --workspace @arquifusion/backend
npm.cmd test --workspace @arquifusion/backend
npm.cmd run validate:infra --workspace @arquifusion/backend
npm.cmd run build --workspace @arquifusion/frontend
npm.cmd test --workspace @arquifusion/frontend
git diff --check
```

Cloudflare Pages uses the monorepo root, build command `npm run build --workspace @arquifusion/frontend`, and output directory `apps/frontend/dist`. Set the public API URL as `VITE_API_URL`; configure the existing public Cognito variables from the project README. Ensure a SPA fallback routes application paths to `index.html`; verify the Cloudflare project has the repository root and no committed credentials. Build output is generated locally and must not be committed.

For a reviewed AWS release, first validate/build and inspect generated Serverless packages, then deploy only the platform foundation (if not already owned), Operations, and AURA in dependency order, followed by an API route/auth smoke test using dedicated test users. Do not deploy over existing stacks or routes until actual ownership and drift are verified. This repository change did not run `serverless deploy` and does not provide evidence of deployed behavior.

## Not complete / risks

- Invitation depends on the target Cognito pool's email delivery configuration and external lifecycle IAM role; neither can be validated without AWS deployment credentials.
- No account with a real technician identity was provisioned here; exercise the new scoped APIs with an AWS test user after a reviewed deployment.
- There is no full cross-table atomic transaction for all assignment, Operations incident/order, membership, and event updates. Existing per-table version checks and event writes remain, but reconciliation/idempotent replay should be exercised in an AWS integration test.
- The additive `ByTenantAssignee` index requires CloudFormation to finish building before the backfill and AURA code release. Keep the index on rollback because it is non-destructive and the Lambda code can continue using it.
- Actual LabRole/AWS Academy permissions, CloudFormation state, API Gateway route conflicts, Cognito membership records, and Render secret configuration were not accessible for verification.
- The enterprise demo seed is a script for an already-authenticated development tenant. It sends two real Cognito invitations to operator-supplied email addresses; it does not create an administrator or bypass tenant membership setup.
