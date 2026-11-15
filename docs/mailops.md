# ArquiFusion MailOps — MVP local

## Maintenance Intelligence

El motor de reglas deterministas está en cloud/aws/src/mailops/maintenance-intelligence.ts. MailOps lo ejecuta después de la normalización existente (parseCsv / normalizeRows) y antes del informe. No modifica la flota, DynamoDB, inventario ni máquinas. El informe separa hallazgos deterministas con evidencia de las interpretaciones opcionales de Gemini. Si Gemini no responde, se conserva la evaluación determinista y el informe básico.

La normalización actual aporta tenant, identificador, modelo, categoría, ubicación, estado y opcionalmente horas de operación, temperatura, vibración, presión y consumo. No ingiere carga, RPM, series históricas ni historial de mantenimiento. updatedAt se genera al normalizar y no es un timestamp de lectura. MachineReading y MaintenanceRecord son entradas opcionales, nunca inferidas. Los campos ausentes aparecen como datos faltantes.

Reglas configurables por modelo y/o categoría cubren rangos de señales, horas elevadas, combinación de variables, cambio respecto de al menos tres lecturas previas, desviaciones frente a por lo menos tres pares del mismo tenant/modelo/tipo e intervalos preventivos. Sin regla compatible, el resultado puede ser INSUFFICIENT_DATA; no hay umbrales globales inventados. Valores de fixtures son solo de demostración, no especificaciones del fabricante. La severidad de reglas produce CRITICAL, HIGH, MEDIUM o NORMAL; estados de origen stopped/alert/maintenance también se reportan como evidencia del registro. Gemini no determina criticidad.

Configuración local opcional de reglas para MailOps (solo ejemplo simulado):

~~~powershell
$env:MAILOPS_MAINTENANCE_RULES_JSON = '[{"category":"hauler","ranges":{"temperature":{"max":90},"vibration":{"max":8},"pressure":{"min":100,"max":300},"fuelConsumption":{"max":35}},"operatingHoursHigh":8000,"maintenanceIntervalHours":1000,"maintenanceDueSoonHours":150,"combined":[{"metrics":["temperature","vibration","pressure","fuelConsumption"],"minSignals":2,"severity":"CRITICAL","label":"multiple-demo-thresholds"}]}]'
~~~

Para el cálculo preventivo se requiere horas actuales, horas anotadas en el último servicio y un intervalo explícito del registro o de la regla. maintenanceDueSoonHours puede configurarse; si se omite, se usa el 10% del intervalo local. No se recomienda un intervalo de fabricante. La detección de variación histórica necesita al menos tres lecturas anteriores con timestamp. La comparación entre máquinas es dentro del tenant y requiere tres pares suficientes.

### Demo reproducible

cloud/aws/fixtures/maintenance/demo.json incluye siete ejemplos y el aviso SIMULATED: normal, temperatura alta, vibración alta, anomalías múltiples, mantenimiento próximo, mantenimiento vencido y datos insuficientes. No son datos productivos ni telemetría validada.

~~~powershell
npm.cmd run demo:maintenance --workspace @arquifusion/backend
~~~

El comando compila y presenta clasificación, hallazgos, evidencia y evaluación preventiva. Para usar las reglas en el worker local, exporta MAILOPS_MAINTENANCE_RULES_JSON antes de iniciar el worker; el resto del flujo MailOps y su fallback Gemini permanecen igual.

El dashboard React aún no consume esta evaluación. Una integración futura debe añadir un endpoint autenticado que resuelva el tenant desde la sesión en backend, recupere registros e historial disponibles, pagine los resultados y presente prioridad, reglas, evidencia y datos faltantes. No debe confiar en tenantId enviado por el navegador.

Este MVP resuelve trazabilidad de anomalías, prioridad explicable, evaluación preventiva si existe el historial requerido y una salida honesta cuando los datos son incompletos. No afirma predicción de fallas: hoy no se guardan series temporales y no existe dataset etiquetado con evaluación temporal.

## Auditoría y arquitectura

Las rutas Lambda de ingesta en `cloud/aws/src/api/handlers/ingestion.ts` autorizan el token Cognito, scope y rol de tenant. `IngestionService.ingest` usa `parseCsv`/`normalizeRows`, guarda el original y hace upsert de máquinas. Los adaptadores cloud usan S3 por tenant y DynamoDB por clave de tenant. No debe llamarse a ese servicio desde MailOps en modo análisis: muta la flota. MailOps reutiliza exclusivamente `parseCsv`, `normalizeRows` y `aggregateFleetMetrics`, en memoria. El tenant siempre procede del mapa de remitentes autorizados, nunca del adjunto.

Los stacks de platform, fleet, ingestion, intelligence y supervisor comparten API Gateway y Lambdas; platform administra tablas y bucket, Supervisor usa Step Functions y su repositorio DynamoDB para tareas. El supervisor tiene sus propios estados (`PENDING`, `QUEUED`, etc.), distintos de los estados MailOps. La implementación LangGraph AWS usa reglas deterministas sobre máquinas persistidas. El servicio Python de Google Cloud expone `/v1/intelligence/analyze` con autorización y contrato de eventos; su proveedor Gemini es independiente. MailOps tiene un cliente HTTP opcional para ese servicio; las rutas AWS existentes de ingesta y recomendaciones no son un adaptador de análisis aislado del adjunto.

`MailProcessor` sigue RECEIVED → VALIDATING → PROCESSING → ANALYZING → GENERATING_REPORT → SENDING → COMPLETED, o FAILED. La respuesta de texto y HTML se guarda con el trabajo para reintentar un rechazo inequívoco; un resultado de envío ambiguo no se reintenta. Se requiere confirmación del ID del proveedor. El mock almacena las respuestas en memoria; el reporte usa la fecha inyectada y el hash del archivo, y es reproducible con la fixture. No se genera PDF. La verificación de correo, permisos y Gemini son contratos de dependencia, no se fingen llamadas externas.

## Ejecutar sin credenciales

Desde la raíz del repositorio (Node 24):

```powershell
npm.cmd run build --workspace @arquifusion/backend
node cloud/aws/dist/mailops/demo.js
node --test cloud/aws/dist/tests/mailops.test.js
```

La demo lee `cloud/aws/fixtures/mailops/message.json` y `fleet.csv`, usa identidad y correo de ejemplo, imprime un informe de datos de demostración y no accede a Gmail, AWS ni Gemini. `fleet.json` es una fixture adicional. Los informes reales contienen información operativa: no imprimirlos en logs de producción.

## Seguridad y limitaciones que impiden usar Gmail real todavía

- El mock confía en `identityVerified` solo como fixture; no constituye autenticación. `GmailAdapter` requiere un `SenderVerifier` externo y rechaza mensajes cuando falla. No hay verificador listo para producción: el campo From, el Reply-To o una cabecera Authentication-Results arbitraria no son prueba suficiente. Se necesita un mecanismo verificado de origen, asociación de identidad y controles contra spoofing/reenvío, además de la lista explícita y revisada de email → tenant. El envío solo va al email autorizado, no al Reply-To. Si no existe evidencia confiable, rechazar sin responder.
- `MemoryMailJobRepository` sigue siendo solo una demo en memoria. La alternativa SQLite local descrita abajo aporta persistencia y leases, pero no es un repositorio cloud ni basta para operar con Gmail real. Hay que conciliar envíos ambiguos con evidencia del proveedor antes de cualquier reintento manual. Gmail no garantiza exactamente una respuesta mediante este flujo.
- El adaptador Gmail es una biblioteca preparada, no existe runner ni proveedor de tokens real configurado. Lista la bandeja y depende del repositorio para deduplicar; no cambia etiquetas ni marca leídos. Un buzón grande requiere política de retención, paginación incremental y cuotas. Al reiniciar el mock se pierde todo el estado. No se guardan ni procesan adjuntos de correos no verificados; los fallos del listado requieren operación/reintento externo.
- El contenido y los campos del archivo son datos no confiables. El módulo no ejecuta fórmulas ni comandos. El adaptador opcional minimiza y seudonimiza los datos enviados, pero la salida de un LLM requiere revisión humana: comprobar evidencia no demuestra que la recomendación o su texto sean correctos. Un fallback nunca se presenta como Gemini.
- El máximo por archivo es 8 MiB y se requiere un solo CSV/JSON UTF-8. Se valida estructura con el normalizador existente; no se garantiza detección de todos los formatos binarios o contenido malicioso semántico. No se guardan originales ni máquinas. El reporte incluye conteos y anomalías basadas en estado; no incluye detalles por fila rechazada. Los trabajos fallidos no envían informes de error automáticamente.
- En el mock, los jobs y reportes se conservan en memoria sin cifrado y solo durante el proceso. Producción requiere cifrado, políticas de expiración, privacidad y auditoría sin contenido sensible, protección de secretos y aislamiento de tenant. No hay API pública, webhook, infraestructura ni tarea programada MailOps.

## Cola y persistencia local v2

`SqliteMailQueue` guarda el mensaje, el trabajo y su entrada de cola en una única fila y transacción SQLite: no hay intervalo entre persistir y publicar. La restricción única por ID evita duplicados entre reinicios; un lease con token aleatorio y versión condiciona cada actualización. Una reclamación vencida puede recuperarse y el worker anterior pierde la capacidad de guardar o confirmar. Un trabajo abandonado en `SENDING` se marca FAILED con entrega incierta y se envía a la cola de fallos, sin reenvío automático. `MailReceiver` verifica el remitente antes de escribir; `MailWorker` reutiliza `MailProcessor`, con análisis sin escritura de flota. La cola se confirma solamente tras estado terminal persistido. Ante rechazo de envío inequívoco usa hasta tres intentos con backoff exponencial de 1 s, 2 s, etc., limitado a 60 s; los fallos definitivos quedan en estado `dead` para intervención.

El archivo SQLite contiene adjuntos, direcciones y reportes en texto legible; usar únicamente datos de prueba en un directorio protegido. Requiere cifrado, control de acceso y políticas de privacidad antes de datos reales. `node:sqlite` de Node 24 emite advertencia experimental. No usar SQLite sobre almacenamiento de red no compatible con WAL.

## Worker residente local v3

Desde la raíz y con Node 24, configurar una base local de prueba y una lista explícita de remitentes (solo fixtures, sin identidad real):

```powershell
npm.cmd run build --workspace @arquifusion/backend
$env:MAILOPS_DB = 'C:\Users\anton\Desktop\HackCloud\mailops-local.sqlite'
$env:MAILOPS_ALLOWLIST_JSON = '[{"email":"operador@example.test","tenantId":"demo","name":"Organización de demostración"}]'
node cloud/aws/dist/mailops/local-cli.js seed-demo
node cloud/aws/dist/mailops/local-cli.js worker
```

El worker usa exclusivamente un adaptador de envío mock; no accede a Gmail. Ctrl+C o SIGTERM detienen la recepción de trabajos nuevos y esperan a que termine el trabajo actual. Opciones: `MAILOPS_POLL_MS` (por defecto 1000, rango 10–60000), `MAILOPS_LEASE_MS` (30000, rango 300–3600000), `MAILOPS_MAX_ATTEMPTS` (3, rango 1–20) y `MAILOPS_RETENTION_HOURS` (168, rango 1–87600). Los números son enteros. No hay credenciales ni cambios de infraestructura.

Los leases se renuevan cada tercio de su duración con el token y la versión actuales. Cada persistencia y el inicio del envío requieren lease válido. Si se pierde durante una operación externa ya iniciada, esta no puede deshacerse: la recuperación de `SENDING` queda en cuarentena por posible entrega. El cierre ordenado espera operaciones en curso; una operación que no termine puede impedir la salida, por lo que un futuro proveedor real necesita timeout y cancelación explícitos. Tras una caída, volver a iniciar el worker; los leases vencidos son recuperables en el siguiente sondeo. El sondeo continúa incluso si una recuperación solo mueve una entrega incierta a cuarentena.

Los rechazos de envío explícitos son reintentables con backoff exponencial, hasta el máximo configurado; una entrega incierta pasa a `dead` sin reintento. Fallos de validación y procesamiento se consideran permanentes en esta versión, no se clasifican todavía errores transitorios de un procesador externo. Para inspeccionar y recuperar, con la misma `MAILOPS_DB` y acceso del sistema al archivo:

```powershell
node cloud/aws/dist/mailops/local-cli.js failures demo
node cloud/aws/dist/mailops/local-cli.js history demo fixture-csv-1
node cloud/aws/dist/mailops/local-cli.js retry demo fixture-csv-1 --confirm
node cloud/aws/dist/mailops/local-cli.js cleanup
```

El comando de reintento requiere que el tenant coincida, estado fallido, reporte existente y entrega no ambigua; no desbloquea cuarentenas. El parámetro tenant no autentica al operador: la autorización local depende de los permisos del sistema de archivos y del proceso, no de un control de identidad implementado por el CLI. La inspección de historial no muestra contenido ni destinatarios. Los logs del worker contienen identificador de trabajo, tenant, estado, duración y código genérico, sin adjuntos ni tokens.

La limpieza periódica y `cleanup` eliminan el reporte, destinatario y payload de trabajos completados tras el plazo configurado, conservando la tumba de idempotencia y el historial. No eliminan fallidos o cuarentenas: requieren revisión y una política posterior. El borrado lógico de SQLite no garantiza eliminación física de copias, páginas libres, WAL o backups; no es cifrado ni borrado seguro. Los trabajos/tumbas se conservan indefinidamente para evitar reingestión, por lo que hay que definir una política de tamaño y privacidad antes de producción.

El contrato `cloud-ports.ts` documenta las operaciones futuras de DynamoDB y SQS: **son interfaces, no adaptadores funcionales**, y no realizan llamadas ni crean recursos. La versión AWS necesita implementar transacción de job + outbox, publicación recuperable, condiciones por versión y lease, deduplicación ante entregas repetidas de SQS, renovación de visibilidad y borrado después de persistir estado terminal. Debe conservar la cuarentena de SENDING, usar referencias protegidas para adjuntos, y someterse a pruebas de concurrencia y fallos reales. El receptor Gmail real y un verificador de identidad confiable siguen pendientes.

Desde la raíz, instalación y validación local:

```powershell
npm.cmd ci
npm.cmd run build --workspace @arquifusion/backend
node --test cloud/aws/dist/tests/mailops.test.js cloud/aws/dist/tests/mailops-durable.test.js
node cloud/aws/dist/mailops/demo.js
node cloud/aws/dist/mailops/benchmark.js
```

El benchmark genera nueve escenarios con 100, 500 y 1000 mensajes y 2, 5 y 10 workers asíncronos en un único proceso, SQLite local y envío mock. Mide el tiempo total incluyendo inserción, trabajos enviados por segundo y latencia p50/p95 por ejecución de worker, errores y pendientes. No es un benchmark de ejecución multiproceso ni de AWS, y el escenario sin fallos registra cero reintentos. Las pruebas incluyen competencia de dos procesos por un lease, reinicio de la base, duplicados, expiración y fallo transaccional; no demuestran funcionamiento ante todos los modos de fallo del SO o del disco.

Costes futuros: DynamoDB factura lecturas, escrituras, almacenamiento y opciones adicionales; SQS factura solicitudes y tamaño de mensajes; Lambda factura invocaciones y duración, con posibles costes asociados. Evaluar región, retención, reintentos, polling, transferencia y uso de S3/KMS antes de desplegar; consultar [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [SQS](https://aws.amazon.com/sqs/pricing/) y [Lambda](https://aws.amazon.com/lambda/pricing/).

## Inteligencia Python opcional

HttpIntelligenceProvider (con GcpIntelligenceAdapter compatible) envía eventos v1 `IntelligenceAnalysisRequested` al endpoint Python existente y comprueba el envelope de respuesta, identidad de tenant y las tres identidades del trabajo. Cada llamada lleva como máximo 200 máquinas, secuencialmente, con `taskId`, `executionId` y `correlationId` comunes y un `eventId` diferente por lote. El límite de solicitud y respuesta es 1 MiB. Se envían alias temporales de máquina, estado y lecturas numéricas; no se envían correo, ubicación, modelo, categoría ni el texto del adjunto. El tenantId del envelope es necesario para el contrato. Se rechaza el lote entero si una recomendación tiene alias desconocido o evidencia vacía/no coincidente con el campo y valor enviados. El reporte vuelve a asociar el alias con el ID original localmente y escapa el HTML.

Los estados 429, 502, 503, timeouts y fallos de conexión tienen reintentos acotados; las respuestas inválidas no se reintentan. Si un lote falla, no se publican resultados parciales: el informe básico se genera sin recomendaciones. Al perder el lease se cancela la solicitud, no se inicia otro lote y el worker no envía correo; una llamada ya recibida por el servicio remoto no puede deshacerse. La validación de evidencia no verifica afirmaciones arbitrarias en los textos ni elimina todos los riesgos de prompt injection o alucinaciones. Los datos enviados pueden ser operativamente sensibles incluso sin PII. Revisar las recomendaciones antes de actuar.

Selección de proveedor: MAILOPS_INTELLIGENCE_PROVIDER acepta mock, gcp o azure. Sin selector explícito, la configuración histórica MAILOPS_INTELLIGENCE_URL + MAILOPS_INTELLIGENCE_TOKEN + MAILOPS_INTELLIGENCE_MODE sigue seleccionando GCP. Azure usa MAILOPS_AZURE_INTELLIGENCE_URL y MAILOPS_AZURE_INTELLIGENCE_TOKEN o MAILOPS_INTELLIGENCE_TOKEN. MAILOPS_INTELLIGENCE_MODE (gemini o mock), MAILOPS_INTELLIGENCE_TIMEOUT_MS (100–120000, default 10000) y MAILOPS_INTELLIGENCE_ATTEMPTS (1–5, default 3) se comparten. Para detalles de Functions, Key Vault, publicación y rollback, ver docs/azure-intelligence.md. Nunca registrar tokens ni usar variables VITE_*.

Prueba local sin credenciales: en una primera terminal, desde la raíz, ejecutar `python cloud/aws/fixtures/mailops/mock_python_service.py`. Es el handler Python real con un proveedor sustituido solo en ese proceso; imprime un puerto local y utiliza el token de prueba `local-test-only`. En otra terminal configura el worker de la sección anterior y añade, sustituyendo `<PUERTO>` por el impreso:

```powershell
$env:MAILOPS_INTELLIGENCE_URL = 'http://127.0.0.1:<PUERTO>'
$env:MAILOPS_INTELLIGENCE_TOKEN = 'local-test-only'
$env:MAILOPS_INTELLIGENCE_MODE = 'mock'
node cloud/aws/dist/mailops/local-cli.js seed-demo
node cloud/aws/dist/mailops/local-cli.js worker
```

Usa una base nueva si la fixture ya se procesó: la deduplicación impide repetir el mismo ID. Para el servicio Python sin simulación, ejecutar `npm.cmd run dev:intelligence` con `INTELLIGENCE_API_KEY` y `GEMINI_API_KEY` obtenidas por canales seguros en el entorno de ese proceso; eso sí consume la API Gemini y no forma parte de las pruebas de este cambio. El token MailOps debe coincidir con `INTELLIGENCE_API_KEY`, no con la clave Gemini. Consulta la documentación del servicio Python antes de configurar sus dependencias y secretos.

Ejemplo ilustrativo del contrato, sin datos reales:

```json
{"eventId":"batch-1","eventType":"IntelligenceAnalysisRequested","schemaVersion":"1.0","timestamp":"2026-01-01T00:00:00Z","tenantId":"demo","taskId":"job-1","executionId":"run-1","correlationId":"corr-1","source":"arquifusion-mailops","payload":{"machines":[{"machineId":"machine-1","status":"alert","temperature":95}]}}
```

```json
{"eventId":"result-1","eventType":"IntelligenceAnalysisCompleted","schemaVersion":"1.0","timestamp":"2026-01-01T00:00:01Z","tenantId":"demo","taskId":"job-1","executionId":"run-1","correlationId":"corr-1","source":"arquifusion-intelligence","payload":{"provider":"gemini-api","model":"example","recommendations":[{"machineId":"machine-1","priority":"high","category":"maintenance","title":"Revisar","reason":"Alerta","suggestedAction":"Inspeccionar","evidence":{"status":"alert","temperature":95}}]}}
```

Para una integración futura AWS → Cloud Run: desplegar y proteger el servicio de forma independiente, decidir autenticación entre nubes y rotación de secretos, exigir TLS y autorización de invocación, y verificar que la solución de identidad de Cloud Run sea compatible con la autenticación Bearer propia del handler; el cliente actual envía un solo Bearer compartido y no implementa tokens de identidad de Cloud Run. Añadir red restringida, observabilidad sin payloads, límites de coste, aislamiento de tenants y pruebas de contrato con el servicio desplegado. No se ha configurado ni desplegado nada.

## Preparación futura de Gmail y OAuth

1. Usar una cuenta dedicada, un proyecto Google Cloud controlado por la organización y habilitar Gmail API. Configurar la pantalla de consentimiento OAuth, audiencia y usuarios de prueba. Elegir el tipo de cliente correspondiente al runner y registrar sus URI exactas. Completar la verificación de Google cuando corresponda.
2. Solicitar solo `https://www.googleapis.com/auth/gmail.readonly` para leer adjuntos y `https://www.googleapis.com/auth/gmail.send` para responder; no se requiere `gmail.modify` para este diseño. `gmail.readonly` es restringido y `gmail.send` sensible; revisar requisitos de verificación y evaluación de seguridad. No solicitar contraseña. Generar credenciales mediante el flujo OAuth autorizado por Google y guardar client secret y refresh token en un almacén de secretos, nunca en Git, variables `VITE_*`, logs ni fixtures. Inyectar un `GmailTokenProvider` que renueve access tokens de forma segura. No se implementó un flujo OAuth ni variables de entorno para Gmail real en este MVP; no hay un comando listo para usar credenciales reales.
3. Implementar y validar el `SenderVerifier` confiable y un repositorio durable antes de conectar el adaptador a `MailProcessor`. La autorización debe producir la dirección exacta previamente asociada al tenant. Asignar mínimos permisos a buzón, almacenamiento y servicios, y validar aislamiento con cuentas de prueba.
4. Enviar por `messages.send` con `threadId`, `In-Reply-To`, `References` y asunto equivalente. El adaptador no usa `Reply-To`. La confirmación requiere ID de Gmail; si se pierde la respuesta, detener y conciliar, nunca asumir fracaso. El procesamiento repetido se evita mediante el repositorio durable, no mediante la etiqueta de leído.
5. Revisar [scopes de Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes), [hilos](https://developers.google.com/workspace/gmail/api/guides/threads), [OAuth para aplicaciones instaladas](https://developers.google.com/identity/protocols/oauth2/native-app) y [cuotas vigentes](https://developers.google.com/workspace/gmail/api/reference/quota); existen límites por proyecto, usuario y método, además de límites de envío. Usar backoff para lecturas y rechazos inequívocos; nunca reintentar automáticamente un envío ambiguo.
