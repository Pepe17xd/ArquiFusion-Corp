# MVP operacional AWS

## Alcance

El primer corte vertical implementa telemetría → reglas deterministas → anomalía → incidente y orden correctiva → evento operacional persistido. La lectura y la anomalía se confirman en una transacción antes de iniciar la State Machine operacional; la segunda transacción crea incidente, orden y eventos juntos. El workflow existente de `fleet.recommendations` conserva su stack, estados y contratos.

La selección de tenant proviene del access token Cognito verificado y de su membresía. Se permite `x-tenant-id` solo para elegir entre membresías ya verificadas; `tenantId` no se acepta en estos bodies. Lectura requiere `arquifusion/read`; escritura de datos, `operator` + `arquifusion/write`; reglas, `admin` + `arquifusion/write`.

## Contratos HTTP

Todos los endpoints devuelven el envelope existente `{ "data": ... }`. El contrato OpenAPI versionado está en [`packages/contracts/openapi/operations.v1.yaml`](../../packages/contracts/openapi/operations.v1.yaml).

### Ingestión de telemetría

`POST /telemetry/batch` recibe de 1 a 10 lecturas, hasta 256 KiB, y requiere `idempotency-key` de 1 a 200 caracteres seguros. Repetir la misma clave y body retorna el resultado persistido; reutilizarla con otro body retorna `409`. Una segunda clave para la misma máquina y timestamp también retorna `409`.

```json
{
  "readings": [
    {
      "machineId": "EXC-001",
      "timestamp": "2026-11-15T15:10:00Z",
      "metrics": {
        "temperatureC": 96.4,
        "vibrationMmS": 5.7,
        "pressureKPa": 210,
        "fuelConsumptionLph": 24.8,
        "operatingHours": 3812.5,
        "loadPercent": 72,
        "speedKph": 8.5,
        "rpm": 1550
      }
    }
  ]
}
```

El nombre del campo fija la unidad: `temperatureC` (°C), `vibrationMmS` (mm/s), `pressureKPa` (kPa), `fuelConsumptionLph` (L/h), `operatingHours` (h acumuladas), `loadPercent` (% de carga nominal), `speedKph` (km/h) y `rpm`. Se aceptan solo números finitos dentro de los rangos de OpenAPI, fechas ISO-8601 con zona horaria, lecturas no más de cinco minutos en el futuro y máquinas existentes del tenant. Los timestamps se normalizan a UTC. Campos métricos vacíos se omiten; se requiere al menos una métrica.

Respuesta:

```json
{
  "data": {
    "accepted": 1,
    "anomalyCount": 1,
    "anomalies": [{"anomalyId": "<sha256>", "machineId": "EXC-001", "severity": "critical"}],
    "replayed": false
  }
}
```

Un `503` puede ocurrir después de persistir telemetría si Step Functions no acepta el inicio; el cliente debe reintentar el mismo body y la misma clave. La lectura del ledger reintenta el despacho sin volver a insertar lecturas.

### Lecturas, anomalías y reglas

- `GET /telemetry/latest?machineId=EXC-001`
- `GET /telemetry?machineId=EXC-001&limit=25&cursor=...`
- `GET /anomalies?machineId=EXC-001&limit=25&cursor=...`
- `GET /anomalies/{anomalyId}`
- `GET /anomaly-rules`
- `PUT /anomaly-rules` (solo admin)
- `POST /anomalies/{anomalyId}/explanation` (no acepta body)

El primer uso devuelve tres reglas de umbral de inicio: temperatura `>=105 °C` (warning), vibración `>=20 mm/s` (warning) y carga `>100%` (critical). Se marcan como valores de arranque que requieren contraste con el fabricante; un admin puede sustituirlas. Una regla tiene de 1 a 3 condiciones y combinación `all` o `any`, severidad `info|warning|critical`, explicación, operador `gt|gte|lt|lte|changePctGte`, métrica y umbral. `changePctGte` requiere una lectura histórica previa no nula; sin ella la condición no coincide ni inventa una baseline.

Ejemplo de `PUT /anomaly-rules`:

```json
{
  "rules": [
    {
      "ruleId": "heat-and-load-v1",
      "title": "Temperatura y carga elevadas",
      "explanation": "Ambas lecturas exceden los límites configurados para este equipo.",
      "severity": "critical",
      "match": "all",
      "enabled": true,
      "conditions": [
        {"metric": "temperatureC", "operator": "gte", "threshold": 98},
        {"metric": "loadPercent", "operator": "gt", "threshold": 90}
      ]
    }
  ]
}
```

La explicación Gemini/Render reutiliza el `IntelligenceProvider` existente y devuelve su campo `source`. Si el proveedor remoto no está configurado o falla, se conserva `deterministic-rules`. El endpoint solo explica evidencia; no modifica estado, inventario, incidentes ni órdenes.

### Incidentes, mantenimiento y eventos

- `GET /incidents?machineId=...&limit=25&cursor=...`
- `PATCH /incidents/{incidentId}` con `If-Match: "<version>"` y campos opcionales `status`, `assignedTo`, `resolution`. Estados: `open → acknowledged → resolved`; resolución requiere texto.
- `GET /maintenance/orders?machineId=...&limit=25&cursor=...`
- `PATCH /maintenance/orders/{workOrderId}` con `If-Match: "<version>"` y campos `status`, `assignedTechnicianId`, `intervention`. Estados: `planned → in_progress → completed` o `cancelled`; intervención requiere `occurredAt` y notas.
- `GET /operations/events?machineId=...&limit=25&cursor=...`

Una anomalía crítica genera un incidente abierto, una orden correctiva planificada de prioridad alta y eventos `IncidentCreated`, `MaintenanceOrderCreated`, `NotificationRequested` y `AnomalyWorkflowProcessed`. Las mutaciones de incidente/orden usan escritura condicional de versión y guardan su evento en la misma transacción. El endpoint existente `GET /events` mantiene intacto el historial del Supervisor.

`NotificationRequested` es un outbox persistido e idempotente; esta fase **no envía correo/SNS**. No se atribuye entrega a un proveedor. La conexión a un canal externo queda pendiente porque la API Gmail actual no ofrece idempotencia durable frente a un resultado de entrega incierto.

## Persistencia e índices

El stack `serverless.operations.yml` crea una tabla separada `OPERATIONS_TABLE`, en `PAY_PER_REQUEST`, con cifrado administrado por DynamoDB, PITR, TTL solo para el ledger de idempotencia y `DeletionPolicy/UpdateReplacePolicy: Retain`.

| Acceso | Clave |
|---|---|
| Registro base | `pk=TENANT#{tenantId}`, `sk={entityType}#{entityId}` |
| Por tenant y tipo (GSI `ByTenantType`) | `gsi2pk=TENANT#{tenantId}#TYPE#{type}`, `gsi2sk={createdAt}#{entityId}` |
| Por tenant, máquina y tipo (GSI `ByTenantMachine`) | `gsi1pk=TENANT#{tenantId}#MACHINE#{machineId}`, `gsi1sk={type}#{timestamp}#{entityId}` |

Entidades: `TELEMETRY`, `ANOMALY`, `INCIDENT`, `WORK_ORDER`, `EVENT`, `RULE_SET`, `IDEMPOTENCY`. Las consultas usan `Query`, cursores codifican la clave DynamoDB completa y el repositorio valida que pertenezca al tenant/índice consultado. Las lecturas se guardan en DynamoDB en esta fase; una política de retención/archivo a S3 debe acordarse antes de habilitar grandes volúmenes.

## Step Functions y roles IAM

La nueva Standard State Machine `arquifusion-operations-${stage}-anomaly-processing` contiene su propio worker `processAnomaly`, reintentos acotados y fallo terminal. No reemplaza ni modifica `FleetRecommendationsStateMachine`. Crear las órdenes/eventos es idempotente aunque una ejecución se repita; la clave de despacho incluye tenant y anomalía y los efectos usan IDs estables.

Las funciones operacionales requieren ARNs de roles **preexistentes** dedicados; el template no crea roles ni amplía LabRole:

- `OPERATIONS_READ_ROLE_ARN`: `dynamodb:GetItem`, `dynamodb:Query` sobre `OPERATIONS_TABLE` e índices, `MACHINES_TABLE` y las lecturas de `TENANTS_TABLE`/índice `ByUser` usadas por Cognito.
- `OPERATIONS_INGEST_ROLE_ARN`: permisos de lectura anteriores, `dynamodb:TransactWriteItems` y `dynamodb:GetItem` en la tabla operacional, `states:StartExecution` solo en la State Machine operacional.
- `OPERATIONS_ADMIN_ROLE_ARN`: lectura y `dynamodb:PutItem` condicional para el registro de reglas, limitado a la tabla operacional.
- `OPERATIONS_WRITE_ROLE_ARN`: lectura, `dynamodb:TransactWriteItems` y `dynamodb:GetItem` en la tabla operacional para transiciones versionadas.
- `OPERATIONS_WORKER_ROLE_ARN`: `dynamodb:GetItem`, `dynamodb:TransactWriteItems` en la tabla operacional y lectura de máquina/tenant requerida por el runtime.
- `OPERATIONS_STEP_FUNCTIONS_ROLE_ARN`: `lambda:InvokeFunction` exclusivamente sobre `ProcessAnomalyLambdaFunction` de este stack.

Antes de desplegar, confirmar los nombres físicos de tablas y el ARN exacto de State Machine en las políticas. No adjuntar `dynamodb:*`, `states:*` ni `lambda:*`. `WEB_ORIGIN` mantiene CORS de origen exacto; el stack platform actualiza métodos GET/POST/PUT/PATCH y header `If-Match`.

Para secretos Render/Gemini o Google, usar Secrets Manager/SSM Parameter Store con cifrado KMS y permisos de lectura mínimos. No poner valores en Git, `.env`, `serverless print`, bundles ni logs. Esta fase permite fallback determinista sin configurar IA remota; el patrón de lectura runtime desde Secrets Manager/SSM debe implementarse antes de habilitar una clave productiva en Lambda.

## Empaquetado de workspaces

El backend declara `@langchain/langgraph` como dependencia de runtime y el módulo de operaciones también importa el `IntelligenceProvider`. La presencia en el `package.json` del workspace no demuestra que esté en cada ZIP `package.individually`. Se debe empaquetar desde el root/workspace con npm lockfile y revisar el contenido de cada ZIP: el entrypoint `dist/api/domains/operations.js`, `node_modules/@langchain/langgraph`, sus dependencias transitivas y módulos AWS SDK requeridos. No copiar todo el `node_modules` raíz; si el ZIP no incluye dependencias transitivas, detener el release y corregir la estrategia de empaquetado/bundling del workspace.

## Tests y despliegue revisado

Desde la raíz del monorepo:

```powershell
npm ci
npm run build --workspace @arquifusion/backend
npm run test --workspace @arquifusion/backend
npm run validate:infra --workspace @arquifusion/backend
```

Para preparar sin desplegar, desde `cloud/aws` exportar los valores de integración existentes (`HTTP_API_ID`, `HTTP_API_AUTHORIZER_ID`, `MACHINES_TABLE`, `TENANTS_TABLE`, `AWS_ACCOUNT_ID`, `COGNITO_ISSUER`, `COGNITO_AUDIENCE`, `WEB_ORIGIN`, `AWS_LAMBDA_ROLE_ARN`) y los seis roles operacionales anteriores, `AWS_STEP_FUNCTIONS_ROLE_ARN` si lo requiere el entorno y `OPERATIONS_TABLE`. Entonces:

```powershell
npx serverless package --config serverless.yml --stage dev --region us-east-1
npx serverless package --config serverless.operations.yml --stage dev --region us-east-1
```

Revisar los templates/ZIP y el change set del stack platform por el cambio CORS. Desplegar, solo tras esa revisión, primero el stack platform actualizado y luego `serverless.operations.yml`; verificar que API ID, authorizer, tablas y stage correspondan. No desplegar el stack Supervisor ni borrar recursos. Esta sesión no ejecutó empaquetado AWS ni deploy.

Pasos exactos de despliegue revisado, ejecutados desde `cloud/aws` y con las variables verificadas para el mismo stage/cuenta/región:

```powershell
npx serverless package --config serverless.yml --stage dev --region us-east-1
npx serverless package --config serverless.operations.yml --stage dev --region us-east-1
# Revisar .serverless/cloudformation-template-update-stack.json y todos los ZIP
# Confirmar retención de OperationsTable, rutas/authorizer, roles y dependencias
npx serverless deploy --config serverless.yml --stage dev --region us-east-1
npx serverless deploy --config serverless.operations.yml --stage dev --region us-east-1
```

`OPERATIONS_STATE_MACHINE_ARN` lo deriva Serverless del nombre de stack/stage/cuenta/región; el rol de Step Functions es el preexistente `OPERATIONS_STEP_FUNCTIONS_ROLE_ARN`. Configurar credenciales privadas solo mediante un mecanismo runtime aprobado (Secrets Manager/SSM); esta plantilla no acepta ni empaqueta `INTELLIGENCE_API_KEY`.

## Pendiente y riesgos

- Inventario y técnicos no se habilitan aún. La tabla admite entidades futuras, pero reservar stock requiere un ledger de movimientos/reservas y transacciones condicionales específicas; la asignación requiere contratos de habilidades/disponibilidad y coordenadas del equipo. No se hacen asignaciones ni salidas de stock ficticias.
- Contrato propuesto para la fase siguiente, sin rutas aún: `GET/POST /inventory/parts`, `GET /inventory/stock?locationId=...`, `POST /inventory/movements` y `POST /inventory/reservations`; catálogo y saldo por (tenant, parte, ubicación), movimientos append-only y reservas versionadas. Toda reserva/salida usaría `TransactWriteItems` con condición `available >= quantity`, registro idempotente y rechazo de cantidades no positivas.
- Técnicos propuestos para la fase siguiente: `GET/PUT /technicians` y `POST /maintenance/orders/{workOrderId}/assignment-recommendations`; perfil con habilidades codificadas, disponibilidad explícita y ubicación opcional en coordenadas WGS84. La recomendación ordenaría primero compatibilidad de habilidad, disponibilidad y prioridad; distancia solo entra con coordenadas válidas de técnico y máquina. La asignación final requerirá confirmación y una escritura versionada.
- Correlación de incidentes por zona/ventana temporal no está activa; la máquina existente aporta ubicación textual, no coordenadas normalizadas ni una zona configurada.
- Los umbrales por defecto son solo punto de partida; validar unidades, rangos y límites con manuales de cada modelo antes de operar acciones críticas.
- La entrega externa de notificaciones y archivado S3 siguen pendientes. Los eventos reportan la solicitud durable, no el envío.
