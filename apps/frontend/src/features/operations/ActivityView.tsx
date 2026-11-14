import { Activity } from "lucide-react";
import type { OperationsOverview } from "../../services/api/client";

export function ActivityView({ overview }: { overview: OperationsOverview | null }) {
  if (overview) return <section className="panel activity-empty">
    <span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">ACTIVIDAD DEL SUPERVISOR</div><h2>Eventos de ejecución</h2>
    <p>Registro local persistente del adaptador de desarrollo. No representa CloudWatch ni una auditoría AWS desplegada.</p>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>EVENTO</span><span>TAREA</span><span>EJECUCIÓN</span><span>RESULTADO</span><span>AGENTE</span></div>
    {overview.recentEvents.length ? <div className="event-rows">{overview.recentEvents.map((event) => <article key={event.eventId}><time>{new Date(event.timestamp).toLocaleString("es-PE")}</time><b>{event.eventType}</b><code>{event.taskId.slice(0, 8)}</code><code>{event.executionId.slice(0, 8)}</code><span>{String(event.payload.state ?? event.payload.resultCount ?? "registrado")}</span><span>{String(event.payload.agentId ?? "supervisor")}</span></article>)}</div> : <small>Aún no hay eventos de ejecución.</small>}
    <small>Agentes: {overview.agents.filter((agent) => agent.status === "operational").length} operativos · {overview.agents.filter((agent) => agent.status === "planned").length} planificados · {overview.tasks.deadLetter} en DLQ local</small>
  </section>;
  return <section className="panel activity-empty"><span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">ACTIVIDAD DEL SISTEMA / AUDITORÍA</div><h2>El historial persistente de eventos no está disponible</h2>
    <p>El backend aún no ofrece un endpoint de eventos ni almacenamiento duradero de actividad. Las respuestas de importación y del workflow aparecen solo en sus módulos; esta vista no presenta datos de sesión como un registro de auditoría.</p>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>RESPONSABLE</span><span>ACCIÓN</span><span>RECURSO</span><span>RESULTADO</span><span>ID DE EJECUCIÓN</span></div>
    <small>Contrato futuro: eventos de solo anexado con responsable, acción, recurso, resultado, severidad, duración e identificador de ejecución.</small>
  </section>;
}
