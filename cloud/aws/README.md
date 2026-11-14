# AWS Academy

## Unidad y estado

Este directorio contiene el backend TypeScript, el servidor local y cinco configuraciones Serverless: `serverless.yml` (platform), `serverless.fleet.yml`, `serverless.ingestion.yml`, `serverless.intelligence.yml` y `serverless.supervisor.yml`. Platform es propietario de la API HTTP, tablas compartidas y bucket; los cuatro stacks restantes registran sus rutas en esa API y Supervisor posee la State Machine. No se crean roles IAM: se referencia un rol preexistente con `AWS_LAMBDA_ROLE_ARN` (normalmente LabRole en Academy) y `AWS_STEP_FUNCTIONS_ROLE_ARN`.

## Preparar y validar

Desde la raíz del monorepo instala dependencias reproducibles y compila:

```powershell
npm ci
npm run build --workspace @arquifusion/backend
npm run validate:infra --workspace @arquifusion/backend
```

El modo local no requiere AWS:

```powershell
npm run dev:api
```

Para empaquetar sin desplegar, configura las variables AWS descritas abajo y ejecuta desde este directorio:

```powershell
npx serverless package --config serverless.yml --stage dev --region us-east-1
npx serverless package --config serverless.fleet.yml --stage dev --region us-east-1
npx serverless package --config serverless.ingestion.yml --stage dev --region us-east-1
npx serverless package --config serverless.intelligence.yml --stage dev --region us-east-1
npx serverless package --config serverless.supervisor.yml --stage dev --region us-east-1
```

Serverless Framework v4 puede requerir iniciar sesión o una licencia para empaquetar. No hemos verificado empaquetado, permisos ni despliegue en AWS Academy. La validación local de YAML no comprueba CloudFormation ni los permisos efectivos del laboratorio.

## Despliegue futuro

Solo después de verificar la cuota y permisos de API Gateway, Lambda, DynamoDB, S3, Cognito y Step Functions, revisar LabRole y comprobar los artefactos, despliega primero platform y luego los dominios:

```powershell
npx serverless deploy --config serverless.yml --stage dev --region us-east-1
npx serverless deploy --config serverless.fleet.yml --stage dev --region us-east-1
npx serverless deploy --config serverless.ingestion.yml --stage dev --region us-east-1
npx serverless deploy --config serverless.intelligence.yml --stage dev --region us-east-1
npx serverless deploy --config serverless.supervisor.yml --stage dev --region us-east-1
```

Los stacks de dominio requieren `HTTP_API_ID` y nombres/ARN de los recursos de platform para el mismo stage, cuenta y región. `infrastructure/cognito.yml` es una plantilla opcional separada: Cognito no está habilitado hasta confirmar que Academy permite crear esos recursos. Step Functions tampoco se debe asumir disponible. Consulta [la auditoría de AWS Academy](../../docs/aws-academy-hardening.md) para propiedad de recursos, variables y limitaciones del Supervisor.

## Variables

Configura en el entorno de despliegue (no las guardes en Git):

- IAM existente: `AWS_LAMBDA_ROLE_ARN`, `AWS_STEP_FUNCTIONS_ROLE_ARN`; overrides opcionales por función: `HEALTH_ROLE_ARN`, `TENANT_READ_ROLE_ARN`, `TENANT_WRITE_ROLE_ARN`, `FLEET_READ_ROLE_ARN`, `INGESTION_WRITE_ROLE_ARN`, `INTELLIGENCE_READ_ROLE_ARN`, `SUPERVISOR_SUBMIT_ROLE_ARN`, `SUPERVISOR_READ_ROLE_ARN`, `SUPERVISOR_OVERVIEW_ROLE_ARN`, `SUPERVISOR_WORKER_ROLE_ARN`.
- Plataforma: `AWS_ACCOUNT_ID`, `AWS_REGION`, `HTTP_API_ID`, `MACHINES_TABLE`, `LEGACY_MACHINES_TABLE`, `TENANTS_TABLE`, `TASKS_TABLE`, `UPLOADS_BUCKET`, `TASK_STATE_MACHINE_ARN`.
- Cognito y CORS para despliegue: `COGNITO_ISSUER`, `COGNITO_AUDIENCE`, `WEB_ORIGIN`.
- Desarrollo local opcional: `STORAGE_MODE=local`, `AUTH_MODE=local`, `SUPERVISOR_DATA_FILE`, `GMAIL_ALERT_RECIPIENT`.

Usa `.env.example` como inventario; solo `VITE_*` se utiliza para configurar el frontend durante build y esos valores son públicos.
