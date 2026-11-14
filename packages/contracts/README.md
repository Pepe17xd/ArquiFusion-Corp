# Contratos compartidos

Esta carpeta contiene contratos portables y versionados. Los consumidores pueden leer los JSON/YAML durante desarrollo/build, pero no existe una dependencia de runtime de Python/GCP sobre TypeScript/AWS.

- `events.schema.json`: sobre de eventos v1 usado por el Supervisor AWS y validado por el servicio Python.
- `openapi/intelligence.v1.yaml`: interfaz HTTP v1 para el servicio independiente de inteligencia.

Un cambio incompatible requiere una nueva versión de contrato y migración coordinada. El endpoint GCP valida `IntelligenceAnalysisRequested` y, mientras no tenga proveedor, responde `503 provider-not-configured`.
