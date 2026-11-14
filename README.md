# ArquiFusion Intelligence Foundation 2.0

Base modular para operaciones de flota. La API Node.js/TypeScript funciona localmente sin credenciales; sus adaptadores cloud para DynamoDB y S3 se seleccionan con configuración. El frontend React consume la API y LangGraph ejecuta un flujo demostrativo de recomendaciones basadas en reglas reproducibles.

## Requisitos y ejecución local

- Node.js 24 LTS y npm 10 o superior.
- No se necesita cuenta cloud para desarrollar ni ejecutar las pruebas.

Desde la raíz del workspace:

~~~powershell
npm ci
npm test
npm run build
~~~

En dos terminales:

~~~powershell
npm run dev:api
~~~

~~~powershell
npm run dev:web
~~~

La API local queda en http://localhost:3001; el dashboard en http://localhost:5173. Vite elimina el prefijo /api al reenviar las llamadas al backend. La persistencia y el archivo de datos local se encuentran en backend/data/; los originales se archivan en backend/data/uploads/. Define LOCAL_DATA_FILE o LOCAL_UPLOADS_DIR para cambiar esas rutas durante el desarrollo.

La API incluye los dos registros de backend/data/machines.json que ya formaban parte del workspace como datos de ejemplo. No se generan lecturas nuevas. En una copia limpia, la flota empieza vacía.

## Arquitectura

~~~mermaid
flowchart LR
  UI[React + TypeScript<br/>Dashboard] -->|HTTP JSON| API[API Gateway HTTP API]
  UIlocal[React + Vite<br/>desarrollo] -->|proxy /api| LocalAPI[HTTP server local]
  API --> L[Lambda handlers<br/>por responsabilidad]
  L --> CORE[Core<br/>Machine, validaciones, errores]
  L --> ING[Ingestion<br/>CSV / JSON, normalización]
  L --> FLEET[Fleet<br/>detalle, filtros, paginación]
  L --> MET[Metrics<br/>agregación completa]
  L --> INT[Intelligence<br/>LangGraph]
  ING --> STORE[Storage interfaces]
  FLEET --> STORE
  MET --> STORE
  INT --> STORE
  STORE --> LOCAL[Adaptadores locales<br/>JSON + archivos]
  STORE --> DDB[(DynamoDB)]
  STORE --> S3[(S3 privado<br/>originales por SHA-256)]
  INT -. futuro proveedor IA .-> GCP[Google Cloud Run<br/>Vertex AI / Gemini]
  ING -. futuro workflow durable .-> SF[AWS Step Functions]
~~~

### Módulos

~~~text
backend/
  src/
    core/          modelos, validación, configuración y errores compartidos
    domain/        punto de entrada compatible con el dominio existente
    storage/       contratos y adaptadores local, DynamoDB y S3
    ingestion/     parseo, normalización compartida, archivo e upsert
    fleet/         filtros, paginación y consulta de máquinas
    metrics/       agregaciones sobre toda la flota
    intelligence/  contrato de proveedor y workflow LangGraph aislado
    api/           adaptadores HTTP y handlers Lambda
    tests/         pruebas unitarias e integración local
  serverless.yml definición de API Gateway, Lambdas, DynamoDB y S3
  scripts/       validación estructural de infraestructura
frontend/
  src/api.ts      cliente HTTP y contratos del frontend
  src/main.tsx    navegación, dashboard y componentes
  src/style.css   sistema visual adaptable
~~~

## Capacidades y contratos HTTP

Todas las respuestas de la API están dentro de { "data": ... }; los errores usan { "data": { "error": "...", "details": [...] } }.

- GET /health
- POST /ingest/csv con cuerpo text/csv
- POST /ingest/json con un objeto Machine o un arreglo JSON
- GET /machines?limit=20&cursor=...&status=operational&category=...&search=...
- GET /machines/{machineId}
- GET /metrics
- GET /intelligence/recommendations

La importación acepta archivos de hasta 8 MB. CSV y JSON comparten normalizeMachine; cada fila se valida por separado y los errores devuelven el índice de fila. Los registros válidos hacen upsert por machineId. El original CSV o JSON se archiva con una clave SHA-256 estable para que reimportarlo no cree otro objeto.

El listado usa cursores opacos. El adaptador DynamoDB conserva el LastEvaluatedKey completo y aplica filtros en Scan; un resultado de página puede tener menos elementos que el límite cuando los filtros descartan filas. Metrics continúa recorriendo hasta terminar las páginas. Las métricas incluyen distribución por estado y categoría, disponibilidad definida como operational / total, y agregados de los campos de telemetría presentes. No se les asigna una unidad de combustible porque el contrato de origen no la define.

Las reglas actuales de Intelligence usan estado registrado, temperatura de 90 o más y vibración de 5 o más como señales demostrativas. No son umbrales aprobados por el fabricante ni un diagnóstico predictivo certificado: deben configurarse con manuales y líneas base de cada modelo antes de usarlas en una operación real. El resultado incluye prioridad, motivo, acción sugerida y evidencia. No llama a un modelo externo y no necesita credenciales. LangGraph coordina el flujo; el contrato IntelligenceProvider permite incorporar después un servicio de Cloud Run y Vertex AI/Gemini.

## Persistencia e infraestructura

STORAGE_MODE acepta local (predeterminado) o cloud. En modo cloud hacen falta MACHINES_TABLE y UPLOADS_BUCKET. El adaptador DynamoDB implementa get, upsert y scan paginado; S3 conserva originales con clave estable, cifrado SSE-S3 y escritura solo bajo imports/. El bucket bloquea el acceso público y configura cifrado. Los clientes AWS usan la cadena estándar de credenciales del SDK; la aplicación no contiene credenciales.

backend/serverless.yml declara HTTP API, Lambdas separadas por ruta, runtime nodejs24.x, tabla on-demand y bucket. El rol de Lambda debe ser un rol existente y se especifica mediante AWS_LAMBDA_ROLE_ARN; en Learner Lab puede ser LabRole si su ARN y trust policy lo permiten. El proyecto no crea roles ni políticas. El rol seleccionado debe tener permisos de ejecución/logs, dynamodb:GetItem, dynamodb:PutItem y dynamodb:Scan sobre la tabla, además de s3:PutObject solo bajo imports/. No se verificaron esos permisos en una cuenta real.

Para validar la plantilla sin desplegar:

~~~powershell
npm run infra:validate
~~~

La validación analiza el YAML, handlers y recursos sin resolver variables ni llamar AWS. Antes de desplegar, configura AWS_ACCOUNT_ID y AWS_LAMBDA_ROLE_ARN; comprueba que región y servicios estén habilitados por el Learner Lab y revisa los permisos del rol existente en el portal. No se ejecutó ningún despliegue ni comprobación de permisos cloud. Serverless Framework 4 requiere una licencia para ejecutar su CLI; por esa limitación el comando local valida la estructura declarada, no el empaquetado integral del Framework.

La región predeterminada es us-east-1, que debe confirmarse contra las restricciones del Learner Lab concreto. AWS Academy cambia las capacidades y regiones habilitadas según laboratorio/curso; no asumas que un permiso declarado localmente está concedido en la cuenta. El runtime Node.js 24 está soportado por Lambda según la tabla vigente de AWS.

### Evolución cloud

- Mantén DynamoDB como almacenamiento operacional. La tabla actual usa machineId como partition key y no tiene GSIs; filtros usan Scan y por ello no escalan como consultas indexadas. Cuando haya requisitos de consulta y cardinalidad definidos, agrega índices y acceso Query con migración documentada.
- Usa Step Functions Standard para procesos que necesiten varios pasos durables, espera, reintentos o auditoría. El endpoint actual procesa cargas pequeñas de forma síncrona; aún no necesita una máquina de estados ni una role de servicio adicional.
- Cloud Run es un límite futuro para ejecutar un proveedor de IA independiente. Vertex AI/Gemini se integra detrás de IntelligenceProvider; este repositorio no incorpora SDK, credenciales ni despliegues GCP aún.

## Decisiones y limitaciones actuales

- Node.js 24 LTS coincide con el runtime Lambda configurado. Vite 8 y su plugin React 6 son las versiones actuales compatibles con el runtime de desarrollo Node 24.
- Los adaptadores local y cloud cumplen los mismos contratos. El almacenamiento local es un archivo de desarrollo: no ofrece concurrencia multi-proceso, transacciones ni las garantías de DynamoDB.
- El dashboard incluye navegación funcional, filtros, paginación, estado vacío, carga y error. El detalle y las recomendaciones consultan endpoints dedicados.
- No hay autenticación ni autorización de usuarios. CORS está abierto para el prototipo; debe restringirse al origen del frontend antes de publicar.
- La integración entre backend AWS y el proveedor IA GCP no está desplegada. Si se incorpora, hay que definir identidad entre nubes, tiempos de espera, límites, costes y tratamiento de datos.
- Step Functions no forma parte del despliegue actual. Su definición se añadirá cuando exista un workflow durable y probado.

### Dependencias principales

- AWS SDK for JavaScript v3: adaptadores DynamoDB y S3.
- LangGraph: ejecución del workflow determinista dentro de Intelligence.
- csv-parse: lectura robusta de CSV con cabeceras y campos entrecomillados.
- yaml: comprobación estructural local de la infraestructura declarada.
- Serverless Framework: infraestructura AWS. El desarrollo local usa el servidor HTTP propio para no depender de una licencia del Framework.
- Vite y plugin React: servidor y build del dashboard.

Se retiraron dependencias iniciales sin uso en el código: serverless-http, ts-node, Serverless Offline y Tailwind/PostCSS. El lockfile fija las versiones exactas instaladas por npm ci.

## Documentación oficial consultada

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [AWS Lambda Node.js runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [DynamoDB Scan y paginación](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html)
- [Step Functions: elegir Standard o Express](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [LangGraph.js quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart)
- [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)
- [Google Gen AI SDK](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/sdks/overview)
