# ArquiFusion Corp

Monorepo para una plataforma de monitoreo y automatización industrial. Cada proveedor tiene una unidad de despliegue separada:

- `cloud/aws/`: API y lógica de negocio TypeScript, cinco stacks Serverless y modo local.
- `cloud/gcp/intelligence/`: servicio Python independiente, preparado para Cloud Run.
- `apps/frontend/`: aplicación React/Vite preparada para Cloudflare Pages.
- `packages/contracts/`: esquemas JSON y contratos HTTP versionados, sin dependencias de runtime entre nubes.

## Requisitos y comandos locales

Usa Node.js 24 y npm 10 o superior. Para Python usa 3.12 o superior; Docker es opcional para construir la imagen de GCP.

```powershell
npm ci
npm test
npm run build
npm run infra:validate
```

Para iniciar el modo local, ejecuta en terminales separadas:

```powershell
npm run dev:api
npm run dev:web
npm run dev:intelligence
```

La API local usa persistencia en `cloud/aws/data/` y no requiere credenciales AWS. El servicio Python valida el contrato de eventos, pero devuelve `503 provider-not-configured` para análisis hasta que se conecte un proveedor real.

## Despliegues

Consulta [AWS Academy](cloud/aws/README.md), [Google Cloud Run](cloud/gcp/intelligence/README.md) y [Cloudflare Pages](apps/frontend/README.md). No se han desplegado recursos desde este repositorio. Los límites gratuitos, permisos y precios dependen de la cuenta y la región; compruébalos antes de crear recursos.

## Arquitectura y contratos

El frontend solo conoce la API HTTP versionada de AWS mediante `VITE_API_URL`. AWS es propietario de Cognito, API Gateway, Lambda, DynamoDB, S3 y Step Functions; el servicio Python no accede a esas bases ni importa código del backend. Una futura llamada AWS → Cloud Run debe usar autenticación de servicio a servicio, TLS, límites de payload, timeout, reintentos acotados, idempotencia y correlación de solicitudes. La interfaz inicial está descrita en `packages/contracts/openapi/intelligence.v1.yaml`.

El backend TypeScript conserva su lógica determinista actual de inteligencia. El servicio GCP todavía no se conecta a ese flujo ni ejecuta un modelo predictivo.

## Licencia

MIT; consulta [LICENSE](LICENSE).
