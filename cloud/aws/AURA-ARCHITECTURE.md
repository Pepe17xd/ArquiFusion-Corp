# AURA — auditoría y decisión previa a integración

## Hallazgos de la Fase 0

- El MVP local tiene `OperationsService`, un repositorio DynamoDB/local, el stack `serverless.operations.yml`, contratos en `packages/contracts/openapi/operations.v1.yaml` y pruebas en `cloud/aws/src/tests/operations.test.ts`.
- La tabla de operaciones usa claves `TENANT#{tenantId}` / `{entityType}#{entityId}` y GSIs `ByTenantType` y `ByTenantMachine`. Los roles Lambda se pasan como ARNs preexistentes. El stack de Operations declara su propia tabla y State Machine Standard y comparte el HTTP API y Cognito authorizer por ID.
- Supervisor vive en `serverless.supervisor.yml`, tiene su propia tabla de tareas/configuración y State Machine. No propongo cambiar sus handlers, contratos, tabla ni workflow.
- No se encontró código, paquete, binario ni contrato de Z3 en el repositorio. No se copiará ni atribuirá código externo; el algoritmo húngaro de AURA será implementación propia y determinista.
- El usuario indica que Operations aún no está desplegado. No se pudo consultar CloudFormation/API Gateway reales: AWS CLI no está instalado en este entorno. Los nombres físicos, rutas ya registradas, roles y drift del entorno deben confirmarse antes de un change set.
- El empaquetado Serverless v4 requiere una licencia o cuenta autenticada. En la sesión anterior el comando terminó antes de crear ZIPs; no se pudo comprobar el contenido de dependencias runtime.

## Conflictos y límites conocidos

- El API HTTP es compartido. Las rutas existentes incluyen `/incidents`, `/incidents/{incidentId}` y las rutas de operaciones. Los prefijos `/technicians`, `/inventory`, `/assignments` y `/incidents/{incidentId}/coordination` no aparecen en los contratos del repo, pero se deben volver a verificar contra el API desplegado antes del despliegue.
- El stack Operations define una tabla nueva con retención. Añadirle GSIs o reemplazar sus claves aumentaría el riesgo de migración. La propuesta no cambia su esquema.
- Ningún policy JSON de los roles externos está versionado en el repo. Los nuevos permisos no se pueden confirmar solo con la configuración Serverless.
- No hay señal documentada de máquina apagada ni SLA configurado. Por tanto, downtime real y cumplimiento de SLA no pueden calcularse con las entidades actuales. El tiempo entre apertura y resolución sí permite un MTTR de incidentes resueltos, definido y acotado por periodo.
- No hay canal de notificación configurado para Operations. Un evento outbox no prueba entrega.

## Decisión propuesta para las fases que tocan AWS

**Stack independiente `serverless.aura.yml`, sin editar Supervisor ni reemplazar recursos.** Será propietario de `AURA_TABLE`, sus GSIs, Lambdas y una State Machine Standard propia. Se registrarán rutas nuevas en el HTTP API y se usará el mismo Cognito authorizer. Ningún recurso existente tendrá `DeletionPolicy` ni propiedades modificadas por este stack.

La tabla AURA guardará técnicos, stock, movimientos, reservas, asignaciones y tokens de callback con TTL. DynamoDB transacciones operarán sobre AURA y la tabla Operations existente para mantener versiones e historial de incidentes/órdenes. DynamoDB permite transacciones entre tablas solo dentro de la misma cuenta y región; requiere policies externas con `dynamodb:TransactWriteItems` sobre ambos ARN. No requiere cambio de esquema en Operations. Fuente: [DynamoDB TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

Step Functions conservará sus tokens `waitForTaskToken` solo en registros internos protegidos; el API y las respuestas nunca devuelven tokens. Cada espera tendrá timeout finito y borrado/expiración de token. Aceptar/rechazar/cerrar verificará tenant del access token, actor autorizado, ID y versión de la asignación antes de notificar a Step Functions. Una respuesta repetida debe tener efecto idempotente.

**Límite IAM del callback:** `states:SendTaskSuccess` y `states:SendTaskFailure` no admiten ARN de recurso en IAM; el permiso requiere `Resource: "*"`. Se aislará en una Lambda callback dedicada, sin rutas de inicio ni acceso a credenciales de otros servicios; su acceso DynamoDB quedará limitado a los registros AURA que contienen callbacks vigentes. Esta excepción debe aparecer explícitamente en la revisión de seguridad. `waitForTaskToken` debe definir `TimeoutSeconds` (y heartbeat solo si se implementa renovación) para evitar ejecuciones suspendidas indefinidamente. Fuente: [acciones IAM de Step Functions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html), [timeouts de estados Task](https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html).

La State Machine se activa mediante una ruta nueva para coordinar incidentes. Antes de aceptar un lote, leerá los incidentes y órdenes de Operations y calculará la asignación global; candidatos no elegibles quedan fuera de la matriz, y columnas dummy permiten dejar incidentes sin asignar. Costos normalizados y pesos versionados por tenant se guardan en AURA. Distancia solo se calcula desde coordenadas WGS84 válidas de máquina y técnico; no se traduce a tiempo de traslado.

El inventario usa ledger de movimientos y reservas en AURA. Reserva, consumo o liberación cambiará stock/reserva con transacciones condicionales, expected version e idempotency key. No habrá decremento de stock fuera de esas transacciones.

Las rutas propuestas son aditivas: `GET/POST /technicians`, `GET/PUT /technicians/{technicianId}`, `POST /assignments/optimize`, `POST /assignments/{assignmentId}/response`, `GET/POST /inventory/parts`, `GET /inventory/stock`, `POST /inventory/movements`, `POST /maintenance/orders/{workOrderId}/reservations`, `DELETE /maintenance/orders/{workOrderId}/reservations/{reservationId}`, `POST /incidents/{incidentId}/coordination`, y rutas de intervención/cierre bajo `/assignments/{assignmentId}`. El OpenAPI AURA será la fuente contractual y las rutas se contrastarán con API Gateway real.

La API no marcará notificaciones como entregadas cuando solo persista un evento. La publicación SNS podrá ser opcional mediante topic ARN y rol dedicado; SNS acepta/publica un mensaje, pero no prueba que un destinatario lo haya recibido.

## Revisión requerida antes de Fases 1–4

La propuesta conserva Supervisor y el esquema Operations, pero añade un stack, una tabla, una State Machine, rutas al API compartido y grants transaccionales entre tablas. Confirmar en AWS el inventario/drift, disponibilidad de roles/policies, API routes y soporte de callback antes de preparar el change set. No desplegar hasta revisar los templates y ZIPs individualmente. En esta auditoría se implementa únicamente el algoritmo húngaro aislado, que no cambia esos recursos.

## Métricas propuestas

- MTTR: promedio de `resolvedAt - occurredAt` para incidentes resueltos dentro del periodo; denominador = incidentes resueltos válidos. Usar historial real.
- Reincidencia: incidentes posteriores de la misma máquina en una ventana fija configurable (propuesta inicial: 30 días), excluyendo el incidente base; mostrar ventana y conteos.
- Cumplimiento de atención: incidentes con `acknowledgedAt - createdAt <= responseSlaMinutes`; devolver SLA/periodo y cantidades cumplidas/evaluables. No calcular hasta configurar SLA.
- Downtime: pendiente hasta disponer de transiciones auditables de máquina a estado no operativo y retorno a operativo. No sustituirlo por el tiempo abierto del incidente.

