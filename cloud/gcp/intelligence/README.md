# Google Cloud Run: Intelligence

Este servicio Python es independiente del backend AWS. Valida el evento versionado compartido y expone `GET /health` y `POST /v1/intelligence/analyze`. No tiene conectado un modelo: los eventos válidos de análisis responden `503 provider-not-configured`; no se generan recomendaciones ficticias.

## Desarrollo y comprobaciones

Desde la raíz:

```powershell
python -m unittest discover -s cloud/gcp/intelligence/tests -v
python -m compileall -q cloud/gcp/intelligence/src
python -c "import sys,runpy; sys.path.insert(0, 'cloud/gcp/intelligence/src'); runpy.run_module('arquifusion_intelligence', run_name='__main__')"
```

O usa `npm run dev:intelligence` para iniciar en `PORT=8080`.

## Imagen y despliegue preliminar

El contexto Docker es la raíz del monorepo porque la imagen copia el contrato desde `packages/contracts`:

```powershell
docker build -f cloud/gcp/intelligence/Dockerfile -t arquifusion-intelligence:local .
```

Para publicar más adelante, crea/reutiliza un repositorio de Artifact Registry (puede generar cargos), autentica Docker con la cuenta elegida y sustituye los valores de ejemplo:

```powershell
$ProjectId = "PROJECT_ID"
$Region = "REGION"
$Repository = "REPOSITORY"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/arquifusion-intelligence:latest"
docker build -f cloud/gcp/intelligence/Dockerfile -t $Image .
docker push $Image
gcloud run deploy arquifusion-intelligence --image $Image --project $ProjectId --region $Region --port 8080 --min 0 --max 1 --no-allow-unauthenticated
```

Son instrucciones, no se han ejecutado. Cloud Run puede tener cuota gratuita sujeta a región, uso y condiciones vigentes; Artifact Registry, tráfico y logging también pueden costar. Revisa precios y presupuestos de GCP antes de crear recursos.

## Configuración y comunicación futura

Cloud Run define `PORT` automáticamente (localmente se usa 8080). No hay secretos ni credenciales en el contenedor. Para comunicar AWS con Cloud Run, conserva el servicio privado y usa identidad de workload/ID token con audiencia restringida, almacenando la URL y credencial de invocación en configuración/secretos protegidos del runtime AWS. AWS debe invocar el endpoint HTTPS con timeout y reintentos acotados, token tenant-aware según contrato, `correlationId`, idempotencia y límites de payload. Antes de habilitarlo, acordar autenticación, autorización tenant, esquema de respuesta y estrategia de fallos. No uses `--allow-unauthenticated` para esta integración.
