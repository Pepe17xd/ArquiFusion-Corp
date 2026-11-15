import { Activity } from "lucide-react";
import type { AgentEvent } from "../../services/api/client";

export function ActivityView({ events, error, loading }: { events: AgentEvent[]; error: string; loading: boolean }) {
  return <section className="panel activity-empty">
    <span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">ACTIVIDAD DEL SUPERVISOR</div><h2>Eventos de ejecución</h2>
    <p>Eventos devueltos por el endpoint de supervisión para la organización activa.</p>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>EVENTO</span><span>TAREA</span><span>EJECUCIÓN</span><span>RESULTADO</span><span>AGENTE</span></div>
    {loading ? <div className="table-message" role="status">Cargando eventos…</div> : error ? <div className="table-message" role="alert">{error}</div> : events.length ? <div className="event-rows">{[...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).map((event) => <article key={event.eventId}><time>{new Date(event.timestamp).toLocaleString("es-PE")}</time><b>{event.eventType}</b><code>{event.taskId.slice(0, 8)}</code><code>{event.executionId.slice(0, 8)}</code><span>{String(event.payload.state ?? event.payload.resultCount ?? "registrado")}</span><span>{String(event.payload.agentId ?? event.source)}</span></article>)}</div> : <small>Aún no hay eventos de ejecución.</small>}
    <small>Los eventos corresponden al historial devuelto por la API; no se presentan como registros de CloudWatch.</small>
  </section>;
}
