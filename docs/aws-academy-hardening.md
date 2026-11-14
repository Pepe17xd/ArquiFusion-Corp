# Hardening local y preparación de AWS Academy

Este documento describe el estado comprobable de la rama `feature/aws-academy-hardening`. El alcance de esta fase es local: no se desplegaron recursos, no se consultaron cuentas y no se usaron credenciales cloud. GCP queda fuera del alcance.

## Estado y límites de servicio

| Unidad | Entrada / contrato | Persistencia | Construcción y prueba independiente | Despliegue independiente |
|---|---|---|---|---|
| API operativa TypeScript | `backend/src/api/handlers.ts`, HTTP API/Lambda | Adaptadores local o AWS elegidos por configuración | Workspace `backend`, `npm run build -w backend` y suite backend | Una pila Serverless. Cada función obtiene artefacto individual (`package.individually`), pero no hay stacks separados por dominio |
| Fleet | Handler HTTP + contratos Machine | Repositorio compartido local/DynamoDB | No es un servicio: prueba dentro del workspace backend | No; comparte autorización, API y almacenamiento |
| Ingestion | CSV/JSON, normalizador común, `OriginalFileStore` | Máquinas + original local/S3 | No es un servicio: prueba dentro del workspace backend | No; comparte API, contratos y persistencia |
| Metrics | Lectura agregada tenant-scoped | Repositorio Fleet | No es un servicio: prueba dentro del workspace backend | No; separado daría poco valor y requeriría coordinación de lecturas |
| Intelligence | Contrato `IntelligenceProvider`, LangGraph determinista | No guarda estado propio | Prueba backend; independiente del transporte en código | No; ejecutado dentro de Lambda por ahora |
| Supervisor | API, worker y contrato de eventos | JSON local o tabla DynamoDB + Step Functions en cloud | Pruebas backend | Worker y dispatcher son Lambdas propias, misma pila Serverless |
| Notifications | Adaptador Gmail pendiente de OAuth | Ninguna | Tests backend de estado no configurado | No es un servicio ni existe ruta de notificación |
| Servicio Python | HTTP `/health` y contrato de eventos | Ninguna | `npm run build:python`, `npm run test:python`; propio `pyproject.toml` | Empaquetable como contenedor local; no integrado ni declarado en AWS |
| Frontend | React/Vite + cliente API y PKCE | `sessionStorage` para sesión cloud; estado operacional lo provee API | Workspace frontend, build y pruebas propias | No se incluye despliegue frontend en la pila backend |

La solución operativa es un backend modular en un solo servicio y una sola pila. No conviene fragmentar Fleet, Ingestion, Metrics e Intelligence en servicios de red mientras comparten almacenamiento, autorización y modelo de despliegue. `api/handlers.ts` quedó como raíz de composición; las adaptaciones HTTP están en `backend/src/api/handlers/*.ts`. Serverless genera un artefacto por función, pero la selección de un servicio/domino para desplegarlo por separado no está implementada ni se ha validado con `serverless package`.

## Entorno local explícito

```powershell
npm ci
npm test
npm run build
npm run infra:validate
npm run dev:api
npm run dev:web
```

Node.js 24 y npm 10 son la línea declarada en `package.json`. Python 3 es necesario para pruebas/compilación de `services/intelligence`. Para probar backend sin iniciar el resto: `npm test -w backend`; frontend: `npm test -w frontend`; servicio Python: `npm run test:python`.

El modo local usa identidad fija `local-dev-user`, `local-demo`, archivos bajo `backend/data`, y un dispatcher en memoria/cola local. No usa Cognito ni AWS. El modo cloud falla al iniciar si no hay tablas, bucket, state machine, Cognito issuer/client ID u origen HTTPS. No existe fallback cloud→local. No pongas valores cloud en el entorno de pruebas locales.

## Autenticación, membresía y autorización

En cloud, API Gateway HTTP API valida JWT, issuer, client/audience y scopes de ruta. La Lambda vuelve a verificar la firma RS256 contra el JWKS derivado del issuer, `token_use=access`, `client_id`, `sub`, scope y vencimiento con `aws-jwt-verify`; nunca toma el `sub` de un claim decodificado sin verificar. El autorizador revalida la membresía seleccionada en la tabla base con lectura consistente, exige tenant activo, rol requerido y scope. `X-Tenant-Id` solo selecciona una membresía ya autorizada. El ID de tenant enviado dentro del registro importado no establece el propietario.

La creación de organización exige usuario autenticado, scope `arquifusion/write`, clave `Idempotency-Key`, nombre limitado, transacción condicional en DynamoDB y un candado por usuario para permitir una sola organización self-service. El primer usuario obtiene `owner`. No hay invitaciones, administración de miembros ni transferencia de propiedad. La firma, issuer, audiencia, expiración y `token_use` se prueban con claves RSA/JWKS locales generadas durante el test; ningún token real se usa.

El frontend implementa Authorization Code + PKCE, `state`, renovación, revocación del refresh token y limpieza de sesión. Estas pruebas cubren la lógica cliente, no un Hosted UI real. Antes de producción hay que probar alta, confirmación, callback, scopes, refresh rotado, revocación/logout y rechazo con un User Pool configurado.

## Aislamiento y persistencia

- Fleet DynamoDB usa `pk=<tenantId>` y `sk=<machineId>`. Los cursores comprueban el tenant de la clave.
- Membresías usan una tabla compartida con `ByUser`; el índice solo enumera. La autorización relee base y metadatos con `ConsistentRead`.
- Tareas, marcadores de idempotencia y eventos comparten tabla con partición `pk=<tenantId>`; create es transaccional y consultas no usan `Scan`.
- Archivos S3 usan `tenants/<tenantId>/imports/<sha256>.<extension>`, SSE-S3, bloqueo de acceso público, `BucketOwnerEnforced` y denegación de transporte sin TLS.
- Los tests adversariales usan Tenant A y B, roles operador/viewer, usuario sin membresía y un verifier de tokens de prueba. Comprueban lectura, ID manipulado, tenant header, escritura de ingestión, métricas, tareas/eventos, rutas de modificación inexistentes, archivo y contexto de workflow interno.
- El test local no reemplaza condiciones DynamoDB reales ni política S3. No se ejecutó LocalStack ni se consultó AWS.

En local, JSON y cola asíncrona solo soportan un proceso; la escritura de archivos es atómica, pero no existe coordinación entre procesos. En cloud, DynamoDB conserva tenants, tareas, eventos e idempotencia; las tablas nuevas declaran PITR y `Retain`. Los originales conservan S3. No existe migración automática de la tabla antigua de máquinas.

## Supervisor y recuperación

Al enviar una tarea, el Supervisor valida `fleet.recommendations`, crea task/execution/correlation IDs, registra solicitud y marcador de idempotencia, asigna la única capacidad existente y despacha `StartExecution` con contexto de tenant completo y nombre estable de ejecución. El worker revalida coincidencia de tenant, tarea, ejecución y correlación contra el registro persistido; al volver, exige estado `SUCCEEDED`. Step Functions Standard limita el task a 330 s, permite dos reintentos de errores transitorios de integración, persiste fallo y termina con `Fail`.

`DEAD_LETTER` es un estado terminal de la tarea, no una SQS DLQ. El workflow estándar retiene historial por un período limitado y admite redrive de ejecuciones fallidas dentro de la ventana de AWS; esto no sustituye la retención del registro de negocio. No añadimos SQS porque ahora hay un único workflow, sin fan-out, buffer de presión o consumidores competidores. Si aparecen esos requisitos, considerar SQS/DLQ y definir redrive/duplicados explícitos.

Step Functions Standard ofrece semántica de ejecución de workflow, pero no hace transaccionales efectos laterales de Lambda. El proveedor actual es una lectura/recomendación determinista; efectos futuros deben ser idempotentes. Un error de red ambiguo en `StartExecution` todavía puede dejar una ejecución iniciada cuyo acuse no llegó; la API informa fallo de dispatch, así que el operador debe inspeccionar task y ejecución antes de volver a solicitarla. La simulación local no reproduce el historial, concurrencia, retries, límites ni redrive de AWS.

`DynamoTaskStore.update` comprueba que el registro exista, pero no usa un número de versión ni una condición de transición sobre el estado anterior. Una invocación duplicada/concurrente del worker podría volver a ejecutar el proveedor y añadir eventos repetidos o sobrescribir el estado más reciente. Hoy el proveedor solo lee datos y calcula recomendaciones, por lo que no repite efectos operativos. Antes de añadir acciones con efectos, debe agregarse control optimista de versión/claim condicional de tarea y una prueba de concurrencia contra el adaptador correspondiente.

## Observabilidad

La API emite JSON con request ID, correlation ID, operación, tenant autorizado, status, duración y tipo de error. Nunca registra JWT ni cuerpos de importación. En local cada solicitud recibe UUID nuevo; el correlation ID entrante solo se acepta con caracteres limitados. Hay logs de seguridad separados para rechazos 401/403. Eventos de negocio se persisten como eventos de tarea; no existe una auditoría general de cambios ni exportación/retención de logs cloud declarada.

## Infraestructura declarada

`backend/serverless.yml` declara una pila AWS: HTTP API, funciones Lambda Node.js 24 por ruta y workers, tablas DynamoDB on-demand, bucket S3 privado, state machine Standard y autorización JWT. El template separado `backend/infrastructure/cognito.yml` declara User Pool, scopes y cliente Hosted UI público PKCE con refresh-token rotation, revocación y protección de borrado. Esto es IaC; no prueba disponibilidad de servicio o permiso en AWS Academy.

El validador local `npm run infra:validate` analiza sintaxis YAML y realiza aserciones estructurales propias. No es CloudFormation Guard, `cfn-lint`, `sam validate` ni validación de AWS. En este entorno no estaban disponibles `cfn-lint`, SAM CLI ni AWS CLI al revisar PATH. `serverless package/deploy` no se ejecutó: el empaquetado de este proyecto puede resolver parámetros/estado remoto y requerir credenciales; tampoco se desea iniciar sesión en cloud en esta fase.

### Roles preexistentes que deben estar disponibles

La plantilla no crea roles. `AWS_LAMBDA_ROLE_ARN` debe ser un rol preexistente confiado por `lambda.amazonaws.com`, y `AWS_STEP_FUNCTIONS_ROLE_ARN` uno confiado por `states.amazonaws.com`. Antes de desplegar, revisar ARN y permisos efectivos en el laboratorio. Como mínimo, el rol Lambda requiere:

- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` solo en grupos de este stack.
- `dynamodb:GetItem`, `PutItem`, `Query`, `TransactWriteItems` solo en tablas tenant/machines/tasks de este stack y el índice `ByUser`.
- `s3:PutObject` solo en `arn:aws:s3:::<bucket>/tenants/*/imports/*`.
- `states:StartExecution` solo en la máquina `fleet-recommendations` de este stack.

El rol Step Functions necesita `lambda:InvokeFunction` limitado a las Lambdas `runTask` y `markTaskDeadLetter`. Si se añade logging de Step Functions, especificar y limitar sus permisos de CloudWatch Logs. Serverless crea permisos de invocación API Gateway para sus propias funciones; no se debe conceder `iam:*` ni permisos administrativos a estos roles. AWS Academy puede imponer nombres de rol, permisos de despliegue, límites de servicios o región; esto debe comprobarse con el administrador del laboratorio, no con un intento de despliegue.

### Variables para una futura preparación cloud

```text
AWS_ACCOUNT_ID
AWS_REGION (opción CLI; predeterminado us-east-1)
AWS_LAMBDA_ROLE_ARN
AWS_STEP_FUNCTIONS_ROLE_ARN
COGNITO_ISSUER
COGNITO_AUDIENCE
WEB_ORIGIN (origen HTTPS exacto para API cloud)
```

El nombre de tabla, bucket y state machine se deriva en `serverless.yml` a partir de servicio, stage y `AWS_ACCOUNT_ID`. No se comparten archivos `.env` ni credenciales. Para cognito.yml se deben decidir `DomainPrefix`, `CallbackUrl` y `LogoutUrl` antes del despliegue, asegurando que las URLs correspondan al cliente realmente publicado.

## Procedimiento de primer despliegue — no ejecutado

Solo después de aprobación operativa y confirmación de cuotas/permisos del laboratorio:

1. Preparar una región, stage único, dominio Hosted UI, URLs HTTPS del frontend y los dos roles existentes; revisar permisos mínimos.
2. Desplegar Cognito primero desde `backend/infrastructure/cognito.yml` con un stack dedicado, `DomainPrefix` único y callback/logout exactos. Recoger los outputs `IssuerUrl`, `WebClientId`, `HostedUiUrl` sin publicarlos.
3. Con los valores del User Pool, preparar variables cloud sin guardar secretos en Git.
4. Desde `backend/`, empaquetar y revisar la plantilla/resultados antes de solicitar el despliegue.
5. Tras aprobación explícita, desplegar la pila `arquifusion-intelligence` con `npx serverless deploy --stage <stage> --region <region>`.
6. Validar health, login, scopes, A/B adversarial, importación, archivo, tarea, fallo/redrive y costes en una cuenta de pruebas.

Comando previsto de Cognito (no ejecutado):

```powershell
aws cloudformation deploy --template-file backend/infrastructure/cognito.yml --stack-name arquifusion-cognito-<stage> --parameter-overrides DomainPrefix=<prefijo-unico> CallbackUrl=<url-callback> LogoutUrl=<url-salida>
```

Comando previsto de API (no ejecutado):

```powershell
Set-Location backend
npx serverless deploy --stage <stage> --region <region>
```

El template de Cognito no crea roles IAM; `CAPABILITY_IAM` puede no ser necesario para esta plantilla y debe omitirse si la revisión del template confirma que no crea recursos IAM. La plantilla API usa roles existentes. Antes del primer despliegue, validar templates con una herramienta CloudFormation oficial disponible y revisar todos los cambios y reemplazos. `serverless package` y `serverless deploy` pueden requerir acceso AWS; no están cubiertos por pruebas locales.

## Validación disponible y pendiente

Comandos locales ejecutados en esta rama:

```powershell
npm test
npm run build
npm run infra:validate
npm audit
git diff --check
```

La suite normal no requiere AWS. JWT local, integración HTTP local, A/B y sesiones frontend son verificables sin nube. Pendiente de validar con entorno real controlado: Hosted UI Cognito, resolución de permisos LabRole, empaquetado Serverless con parámetros reales, validación oficial CloudFormation, semántica real de StartExecution/redrive, acceso DynamoDB/S3 y observabilidad CloudWatch. No hay componentes GCP integrados en esta fase.
