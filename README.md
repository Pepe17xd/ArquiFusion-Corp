# ARQUIFUSION

Base SaaS multi-tenant para inteligencia operacional de flotas. El entorno local funciona sin cuentas cloud. El modo cloud declara autenticación Cognito, datos particionados por tenant, originales privados en S3 y workflows durables de recomendaciones con Step Functions.

## Desarrollo local

Requisitos: Node.js 24 y npm 10 o superior. Python 3.11 o superior solo se necesita para probar o ejecutar `services/intelligence`.

~~~powershell
npm ci
npm test
npm run build
npm run infra:validate
~~~

En terminales separadas:

~~~powershell
npm run dev:api
npm run dev:web
~~~

La API local escucha en `http://127.0.0.1:3001`; Vite sirve el frontend en `http://localhost:5173` y reenvía `/api` a la API. `AUTH_MODE=local` (predeterminado) usa la identidad de desarrollo fija `local-dev-user` y el tenant `local-demo`. No acepta identidad ni tenant indicados en el cuerpo de una solicitud. Esta modalidad solo sirve para desarrollo; no es autenticación.

El estado local se guarda bajo `backend/data/`, que está excluido de Git:

- `machines.json`: registros normalizados. Los archivos preexistentes sin `tenantId` se asignan al tenant fijo `local-demo` al leerlos.
- `tenants.json`: organizaciones y membresías locales. La primera lectura inicializa el tenant `local-demo` en memoria; se persiste al crear otra organización.
- `supervisor.json`: tareas y eventos locales.
- `uploads/tenants/<tenantId>/imports/`: originales CSV/JSON direccionados por SHA-256 dentro del tenant.

Puedes aislar una ejecución de desarrollo con `LOCAL_DATA_FILE`, `LOCAL_UPLOADS_DIR` y `SUPERVISOR_DATA_FILE`.

## Arquitectura

~~~mermaid
flowchart LR
  Web[React + TypeScript<br/>sesión PKCE en navegador] -->|JWT + X-Tenant-Id| Gateway[API Gateway HTTP API<br/>authorizer Cognito]
  Web -->|proxy /api| Local[API HTTP local<br/>identidad fija de desarrollo]
  Gateway --> Lambda[Handlers Lambda por ruta]
  Local --> Lambda
  Lambda --> Core[Core / Fleet / Ingestion / Metrics]
  Lambda --> Auth[Directorio de tenants]
  Auth --> LocalTenant[JSON local]
  Auth --> TenantDB[(DynamoDB<br/>organizaciones + membresías)]
  Core --> MachineDB[(DynamoDB v2<br/>pk=tenantId, sk=machineId)]
  Core --> Files[S3 privado<br/>tenants/{tenantId}/imports]
  Lambda --> Tasks[Supervisor + contrato de tareas]
  Tasks --> LocalTasks[JSON local + ejecución local]
  Tasks --> TaskDB[(DynamoDB<br/>tareas + idempotencia + eventos)]
  Tasks -->|StartExecution| SFN[AWS Step Functions Standard]
  SFN --> Worker[Lambda workflow]
  Worker --> Intelligence[LangGraph determinista]
  Python[Servicio Python HTTP] -. preparado, no integrado .-> GCP[Cloud Run / Vertex AI]
~~~

### Límites del código

- `backend/src/core`: modelo Machine, normalización, configuración y errores compartidos.
- `backend/src/tenancy`: contratos de tenant e implementación JSON local y DynamoDB. La identidad cloud proviene del claim `sub` que API Gateway valida; `X-Tenant-Id` selecciona una membresía y no concede acceso por sí mismo.
- `backend/src/storage`: contratos y adaptadores local/DynamoDB/S3, además de escritura atómica local compatible con Windows.
- `backend/src/ingestion`: CSV/JSON, normalización compartida, validación por fila, SHA-256, archivo del original y upsert tenant-scoped.
- `backend/src/fleet` y `metrics`: listado, detalle, filtros, cursores y agregaciones sobre todas las páginas de un tenant.
- `backend/src/intelligence`: LangGraph permanece aislado y ejecuta reglas deterministas; no llama un modelo externo.
- `backend/src/supervisor`: capacidades registradas, tareas/eventos tenant-scoped, deduplicación por tenant, adaptador local y adaptador DynamoDB; `StepFunctionsTaskDispatcher` inicia el workflow durable cloud.
- `backend/src/api`: adaptadores HTTP para servidor local y Lambda. `health` es público; rutas de negocio requieren membresía y API Gateway aplica scopes Cognito en cloud.
- `services/intelligence`: contrato compartido y servidor Python. Todavía no consulta Vertex AI/Gemini ni está conectado al backend TypeScript.
- `frontend/src`: SPA React, cliente HTTP, PKCE Hosted UI para cloud, selector de organización y vistas operativas. En local usa el proxy Vite y no guarda una identidad real.
- `shared/contracts/events.schema.json`: envoltura de eventos v1 validada por TypeScript y Python.

Los contextos TypeScript están separados por responsabilidad, pero todavía se empaquetan como un único workspace backend y una API. No se declaran microservicios independientes para dominios aún no operativos.

### Tenant y persistencia

La identidad verificada se obtiene del `sub` de Cognito; el backend consulta la membresía de ese usuario. Una solicitud no puede asignar su propio `tenantId` desde un objeto importado. Las máquinas usan la clave compuesta `pk=<tenantId>`, `sk=<machineId>` y las consultas filtran por esa partición. Los cursores DynamoDB conservan la clave completa y se rechazan si su `pk` no coincide con el tenant activo. Los originales usan el prefijo `tenants/<tenantId>/imports/`.

Las tareas de cloud guardan el registro, el marcador de idempotencia y el evento inicial en una transacción DynamoDB. El índice de idempotencia se calcula con SHA-256 y queda bajo la partición del tenant. Step Functions Standard ejecuta el worker; los fallos agotados se registran como `DEAD_LETTER`. En local, el supervisor usa un archivo JSON de un solo proceso y cola en memoria, por lo que no ofrece recuperación distribuida.

La tabla DynamoDB v2 es nueva (`*-machines-v2`); se conserva en el template el recurso lógico y esquema anteriores (`*-machines`) con `Retain`, evitando su reemplazo o eliminación. No hay migración automática de una tabla cloud existente porque sus filas no prueban a qué organización pertenecen. Una migración requiere aprobar el tenant propietario de cada conjunto y copiar los datos de forma explícita.

## Autenticación Cognito y modo cloud

`backend/infrastructure/cognito.yml` declara User Pool, autoservicio de registro, cliente web público sin secreto, Hosted UI y scopes `arquifusion/read` / `arquifusion/write`. El frontend implementa authorization-code con PKCE, `state`, renovación de access token y almacenamiento de sesión en `sessionStorage`. No se incluyen client secrets en el navegador.

Secuencia de configuración cloud (no ejecutada por este proyecto):

1. Revisar que el laboratorio AWS permita Cognito, DynamoDB, S3, API Gateway y Step Functions.
2. Desplegar el template de Cognito por un operador autorizado y obtener `IssuerUrl`, `WebClientId` y `HostedUiUrl` de sus outputs.
3. Configurar para Serverless `COGNITO_ISSUER`, `COGNITO_AUDIENCE`, `AWS_ACCOUNT_ID`, `AWS_LAMBDA_ROLE_ARN` y `AWS_STEP_FUNCTIONS_ROLE_ARN`; el origen web puede configurarse con `WEB_ORIGIN`.
4. Publicar el frontend con `VITE_AUTH_MODE=cognito`, `VITE_API_URL` (URL de API Gateway), `VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_DOMAIN` y `VITE_COGNITO_REDIRECT_URI`.
5. Desplegar infraestructura solo después de revisar permisos, región, costes, datos y migración.

Las Lambdas usan el ARN de rol existente indicado por `AWS_LAMBDA_ROLE_ARN`; la plantilla no crea roles IAM. Ese rol necesita acceso limitado a las tablas de máquinas, tenants y tareas; `s3:PutObject` para originales; `states:StartExecution` sobre el state machine. El rol de ejecución preexistente de Step Functions debe poder invocar solo los dos handlers de workflow. AWS Academy puede limitar la creación de User Pools, state machines o recursos administrados aunque el YAML sea válido; el proyecto no inspecciona perfiles ni permisos de una cuenta.

Validación estática, sin resolver credenciales, contactar AWS ni desplegar:

~~~powershell
npm run infra:validate
~~~

Este comando compila el backend y comprueba YAML, handlers, rutas protegidas, tablas, recursos de Cognito y workflow Standard. No sustituye una validación de permisos, empaquetado o despliegue en una cuenta.

## Integración Google Cloud

El servicio Python ofrece `/health` y valida el envelope de eventos. Para análisis válido aún responde `503 provider-not-configured`. No hay cliente Vertex AI/Gemini, servicio Cloud Run desplegado, llamadas desde TypeScript ni identidad entre AWS y Google. La evolución debe usar autenticación de servicio de Cloud Run con identidad dedicada y tokens OIDC de corta duración, límites de tiempo y minimización de los datos compartidos; nunca claves estáticas en el frontend.

## Contratos HTTP principales

Las respuestas usan el envelope `{ "data": ... }`; los errores usan `{ "data": { "error": ..., "details": [...] } }`.

- `GET /health` — público.
- `GET /tenants`, `POST /tenants` — membresías propias y creación de organización con el usuario autenticado como propietario.
- `POST /ingest/csv`, `POST /ingest/json` — requiere rol `operator` o superior.
- `GET /machines`, `GET /machines/{machineId}`, `GET /metrics`, `GET /intelligence/recommendations`.
- `GET /agents`, `POST /tasks`, `GET /tasks`, `GET /tasks/{taskId}`, `GET /events`, `GET /operations/overview`.

La API acepta CSV/JSON de hasta 8 MB. Los campos `tenantId` enviados en los registros se ignoran: el servicio los deriva del contexto autenticado. Las recomendaciones son reglas demostrativas sobre estado, temperatura y vibración; no equivalen a un diagnóstico certificado ni a un modelo predictivo industrial.

## Capacidades y límites pendientes

- Solo `fleet.recommendations` tiene un workflow real. Las demás entradas del registro de agentes siguen planificadas; no son agentes autónomos.
- Step Functions da durabilidad a la ejecución cloud, mientras que el worker actual realiza hasta tres intentos de proveedor dentro de una invocación Lambda. No existe SQS ni una DLQ SQS; `DEAD_LETTER` es el estado persistido de la tarea.
- El listado de tareas/eventos actualmente recupera el conjunto completo de una partición. Para historiales grandes hace falta introducir cursores y retención antes de operación a escala.
- El directorio permite que un usuario cree organizaciones y asigna `owner`; todavía no existen invitaciones, altas de miembros, gestión administrativa ni recuperación de membresías.
- La UI de tenancy permite elegir una organización existente o crear una nueva. El onboarding multiusuario debe completarse cuando exista el proceso de invitación.
- Cognito, AWS, Google Cloud y OAuth real no se han desplegado ni validado con una cuenta.
- Cloud Run/Vertex AI, notificaciones Gmail, inventario, técnicos, mantenimiento y gestión de incidentes no están integrados como capacidades operacionales.

## Dependencias incorporadas

- `@aws-sdk/client-sfn` (`3.1169.0`): `StartExecution` para despachar tareas al workflow Standard en AWS.
- `csv-parse` (`7.0.3`): parser de registros CSV; se actualizó desde 5.6.0 porque las versiones anteriores a 7.0.2 están afectadas por una vulnerabilidad de reemplazo de prototipo en la opción `columns`. La prueba de regresión de encabezados `__proto__` pasa en la versión fijada.

`npm audit` informa cero vulnerabilidades conocidas al validar este cambio.

## Decisiones y seguridad

- No hay fallback de cloud a identidad local: `STORAGE_MODE=cloud` exige Cognito.
- API Gateway valida JWT, issuer, audience y scopes; las recomendaciones de seguridad multi-tenant de AWS también requieren validar membresías y aislar los datos dentro de la aplicación. Véanse [JWT authorizers de HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) y [recomendaciones de Cognito multi-tenant](https://docs.aws.amazon.com/cognito/latest/developerguide/multi-tenancy-security-recommendations.html).
- Las particiones DynamoDB siguen el patrón tenant partition key; el diseño de claves deberá revisarse ante cardinalidad alta o tenants muy activos. [Estrategias multi-tenant para DynamoDB](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multitenancy-on-dynamodb.html).
- El servicio entre nubes aún no está conectado; para una futura llamada autenticada, Google recomienda una identidad de servicio específica y un ID token OIDC para Cloud Run. [Autenticación servicio a servicio de Cloud Run](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).
- La configuración de Serverless usa un rol ya existente, como LabRole cuando el laboratorio lo permita; no se crean roles ni políticas. [Roles IAM en Serverless Framework](https://www.serverless.com/framework/docs/providers/aws/guide/iam).

## Licencia

Este proyecto usa la licencia MIT; consulta [LICENSE](LICENSE).
