# ARQUIFUSION

## Hardening local y preparación de AWS Academy

La guía [Hardening local y AWS Academy](docs/aws-academy-hardening.md) documenta los cinco stacks locales declarados, propiedad de recursos, configuración con LabRole, concurrencia del Supervisor y límites de validación. Esta fase no desplegó recursos ni usó credenciales cloud.

## Desarrollo local

Requisitos: Node.js 24 y npm 10 o superior. Python 3.11 o superior solo para el servicio de inteligencia Python.

~~~powershell
npm ci
npm test
npm run build
npm run infra:validate
~~~

En terminales separadas: `npm run dev:api` y `npm run dev:web`. La API local usa identidad de desarrollo y persistencia bajo `backend/data/`; no necesita AWS.

## Arquitectura resumida

El backend conserva un workspace TypeScript compartido y un servidor local integrado. Para AWS, cinco configuraciones Serverless separan stacks: platform (API HTTP, tenants, tablas comunes y bucket), fleet, ingestion, intelligence y supervisor (incluye State Machine). Los stacks de dominio se conectan a la API y recursos comunes usando IDs/nombres configurados desde los outputs de platform; no son microservicios con repositorios o runtimes separados. Ver guía para contratos, variables, permisos IAM y empaquetado independiente.

El frontend es React/Vite; la API normaliza CSV/JSON, sirve flota/métricas y ejecuta el workflow LangGraph determinista. Solo ese workflow está operativo. AWS/Cognito no han sido validados en una cuenta y Google Cloud queda fuera del alcance.

## Licencia

MIT; consulta [LICENSE](LICENSE).
