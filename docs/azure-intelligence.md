# ArquiFusion Intelligence en Azure Functions

## Arquitectura

AWS sigue como nube principal: MailOps, cola/leases, autenticación, API Gateway, Lambda, Step Functions, DynamoDB y S3 permanecen igual. React/Cloudflare Pages no llama a Azure. MailOps selecciona un proveedor backend y envía el evento v1 por HTTPS con Bearer.

Azure Functions expone GET /health y POST /v1/intelligence/analyze desde cloud/azure/intelligence/function_app.py. host.json fija routePrefix vacío para conservar las rutas GCP sin /api. La Function importa validate_event, provider.analyze, provider.sanitize y ProviderFailure del paquete existente cloud/gcp/intelligence/src/arquifusion_intelligence. publish.ps1 empaqueta una copia temporal de ese paquete y el schema compartido; no se duplica la lógica Gemini ni se modifica la implementación GCP. packages/contracts/events.schema.json continúa siendo la fuente única del envelope v1.

Azure conserva el formato IntelligenceAnalysisCompleted y los valores tenantId, taskId, executionId y correlationId de la solicitud. Errores compatibles: 400 JSON/evento, 401 Bearer, 413 cuerpo superior a 1 MiB, 429 cuota, 502 fallo del proveedor, 503 configuración faltante. GET /health es público y revela únicamente configuración del proveedor, igual que GCP. Azure Functions auth level es Anonymous porque el handler valida el Bearer de aplicación.

HttpIntelligenceProvider es el cliente HTTP neutro; GcpIntelligenceAdapter sigue siendo compatible. MailOps selecciona azure, gcp o mock. El mock es offline y devuelve cero recomendaciones. El cliente valida tenant, correlaciones, machineId y evidencia, manda lotes secuenciales de hasta 200 máquinas, reintenta errores transitorios y aborta al perder lease. La cancelación remota es best-effort: cortar HTTP no revierte llamadas que ya se iniciaron. Hallazgos deterministas de Maintenance Intelligence se muestran separados de la interpretación opcional de Gemini.

## Requisitos y hosting

Se propone Linux Azure Functions Flex Consumption, sin Always Ready para el MVP, Functions runtime 4 y Python 3.12. Es la opción serverless recomendada por Microsoft; Python 3.12 es la versión común con la imagen actual GCP. Azure for Students y Free Trial tienen cuota Flex regional inicial de 15 cores, pero disponibilidad, SKU y permisos dependen de la suscripción/región. No se fija región.

Consulta con Azure CLI antes de crear cualquier recurso:

~~~powershell
az login
az account show --query "{subscription:id, name:name, state:state}" -o table
az functionapp list-flexconsumption-locations --query "sort_by(@, &name)[].{Region:name}" -o table
az functionapp list-flexconsumption-runtimes --location <REGION> --runtime python -o json
~~~

La oferta estudiantil no garantiza acceso a cada recurso. Si Flex no está disponible, verificar una alternativa y sus límites antes de aprovisionar. No considerar Linux Consumption clásico como decisión de largo plazo: Microsoft anunció su retiro para 2028.

Requisitos locales: Azure Functions Core Tools v4, Azure CLI, Python 3.12, Azurite. Dependencias Python: cloud/azure/intelligence/requirements.txt.

## Desarrollo local

Desde la raíz:

~~~powershell
py -3.12 -m venv cloud/azure/intelligence/.venv
cloud/azure/intelligence/.venv/Scripts/Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r cloud/azure/intelligence/requirements.txt
Copy-Item cloud/azure/intelligence/local.settings.example.json cloud/azure/intelligence/local.settings.json
~~~

Edita solo local.settings.json, ignorado por Git, y aporta INTELLIGENCE_API_KEY y GEMINI_API_KEY por un canal seguro. SET_LOCAL_ONLY es un marcador sin validez. En otra terminal, arranca Azurite, por ejemplo: npx azurite --silent --location "$env:TEMP/arquifusion-azurite". Luego:

~~~powershell
Set-Location cloud/azure/intelligence
func start --verbose
~~~

La Function local importa el paquete GCP original del repositorio. Comprueba health con:

~~~powershell
Invoke-RestMethod http://localhost:7071/health
~~~

Ejemplo ilustrativo de solicitud:

~~~powershell
$event = @{
  eventId = "local-1"; eventType = "IntelligenceAnalysisRequested"; schemaVersion = "1.0"
  timestamp = [DateTime]::UtcNow.ToString("o"); tenantId = "demo"; taskId = "job-1"
  executionId = "run-1"; correlationId = "corr-1"; source = "local-test"
  payload = @{ machines = @(@{ machineId = "machine-1"; status = "alert"; temperature = 95 }) }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri http://localhost:7071/v1/intelligence/analyze -Headers @{ Authorization = "Bearer $env:INTELLIGENCE_API_KEY" } -ContentType "application/json" -Body $event
~~~

Las pruebas automatizadas sustituyen el proveedor dentro del proceso: no necesitan Gemini ni hacen llamadas externas.

## Selección MailOps y seguridad de secretos

La configuración histórica MAILOPS_INTELLIGENCE_URL, MAILOPS_INTELLIGENCE_TOKEN y MAILOPS_INTELLIGENCE_MODE sigue seleccionando GCP si no existe selector explícito. Para Azure:

~~~powershell
$env:MAILOPS_INTELLIGENCE_PROVIDER = "azure"
$env:MAILOPS_AZURE_INTELLIGENCE_URL = "https://<FUNCTION_APP>.azurewebsites.net"
$env:MAILOPS_INTELLIGENCE_TOKEN = "<mismo valor lógico que INTELLIGENCE_API_KEY>"
$env:MAILOPS_INTELLIGENCE_MODE = "gemini"
$env:MAILOPS_INTELLIGENCE_TIMEOUT_MS = "10000"
$env:MAILOPS_INTELLIGENCE_ATTEMPTS = "3"
~~~

El URL es origen base, sin /api ni ruta de analyze. No hay llamadas desde React. Azure usa el provider HTTP neutro; gcp mantiene GcpIntelligenceAdapter; mock no conecta a red.

Para Azure:

1. Activar system-assigned managed identity de la Function App.
2. Asignar Key Vault Secrets User por RBAC sobre el vault, o Get de secretos si se usan access policies.
3. Crear Application Settings INTELLIGENCE_API_KEY y GEMINI_API_KEY como referencias, por ejemplo @Microsoft.KeyVault(SecretUri=https://<VAULT>.vault.azure.net/secrets/intelligence-api-key).
4. Verificar resolución, acceso de red y DNS al vault. Referencias cacheadas pueden tardar hasta 24 horas en refrescarse salvo refresh/reinicio.

Para AWS productivo, el CLI local lee variables, pero Lambda debe resolver el Bearer de Secrets Manager/Parameter Store mediante rol IAM mínimo. El Bearer compartido autentica el servicio, no usuarios finales ni tenants; su compromiso afecta el endpoint. Planificar rotación coordinada y migración futura a identidad máquina a máquina con audiencia validada o gateway. No mezclar Function keys con el Bearer actual: MailOps no envía Function key.

## Preparar el despliegue

El resource group, Storage Account, Function App, identidad y vault se crean fuera de este repositorio y no se han creado aquí. Usar Linux Flex Consumption, Functions v4, Python 3.12, HTTPS y deployment storage; no activar Always Ready al inicio.

Después de crear la Function App y revisar la suscripción activa, publicar desde la raíz:

~~~powershell
./cloud/azure/intelligence/publish.ps1 -FunctionAppName "<FUNCTION_APP>"
~~~

El script prepara en una carpeta temporal el paquete compartido, schema, host.json y requirements.txt; usa Core Tools con build remoto y elimina el staging. Publica código en un recurso existente pero no crea infraestructura. Confirma destino y suscripción en Azure Portal antes de ejecutarlo.

Application Settings requeridas: INTELLIGENCE_API_KEY y GEMINI_API_KEY desde Key Vault, GEMINI_MODEL opcional (defecto del proveedor gemini-2.5-flash), y AzureWebJobsStorage/deployment storage configurados por la Function App. En endurecimiento, migrar conexiones de Storage a identidad administrada y roles Storage requeridos.

Comprobar GET /health y una solicitud de prueba desde runner autorizado. No imprimir tokens, headers o bodies operativos.

## Pruebas, límites y costos

Ejecutar desde la raíz:

~~~powershell
npm.cmd test
npm.cmd run build
~~~

Las pruebas Python de Azure usan un stub de azure.functions para validar rutas, auth, contrato, payload y delegación al código compartido sin cloud ni Gemini. Las pruebas HTTP TypeScript verifican provider Azure, server local, tenant, evidencia, retries, 200 por lote, timeout, cancelación y fallback. El stub no reemplaza prueba de arranque con Core Tools/Azurite.

- Solicitud máxima de aplicación: 1 MiB. MailOps manda a lo sumo 200 máquinas por lote; el proveedor Python heredado recorta a 200 si otro cliente excede ese límite.
- host.json fija tres minutos; Azure Load Balancer limita respuesta HTTP a 230 segundos. Mantener timeout del cliente menor y validar el timeout de Lambda/workflow.
- Gemini tiene cuotas/costos propios. Error de IA conserva el reporte determinista.
- Flex factura ejecuciones y GB-segundo on-demand; Always Ready añade costo de base. No presupuestar grants mensuales de Functions para Azure for Students sin validarlo en Cost Management. Storage, Application Insights, Key Vault operaciones y transferencia pueden sumar cargos.
- Azure for Students anuncia crédito USD 100 por 12 meses para productos elegibles; elegibilidad y oferta pueden variar. La cuota regional Flex inicial de Students/Free Trial es 15 cores y además pueden aplicar policies de la suscripción.
- Al perder lease, abortar HTTP evita lotes posteriores y el envío del informe, pero no garantiza cancelar ejecución remota iniciada.
- No se ha desplegado ni probado la disponibilidad real del tenant Azure.

Referencias oficiales:
[Azure for Students](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/),
[Flex Consumption/cuota](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan),
[regiones](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to),
[precios de Functions](https://azure.microsoft.com/en-us/pricing/details/functions/),
[Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references),
[precios de Key Vault](https://azure.microsoft.com/en-us/pricing/details/key-vault/).

## Rollback

Volver a GCP con MAILOPS_INTELLIGENCE_PROVIDER=gcp, MAILOPS_GCP_INTELLIGENCE_URL o la variable histórica MAILOPS_INTELLIGENCE_URL, MAILOPS_INTELLIGENCE_TOKEN y MAILOPS_INTELLIGENCE_MODE=gemini. Sin selector explícito, la configuración histórica sigue usando GCP. Si no hay URL/token, dejar el provider ausente para conservar el reporte determinista. No cambian contratos ni tablas. Para rollback de Function, re-publicar el último paquete Azure aprobado o dejar de dirigir MailOps a Azure. publish.ps1 no versiona paquetes ni automatiza rollback.
