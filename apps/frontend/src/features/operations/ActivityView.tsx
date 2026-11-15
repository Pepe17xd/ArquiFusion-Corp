import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { AgentEvent, ApiPage, OperationalItem } from "../../services/api/client";
import { auraApi } from "../../services/api/client";
import { toUserMessage } from "../../services/api/user-message";
import { toEventLabel, toStatusLabel } from "../../services/api/user-copy";
import { isLocalPreview } from "../../services/runtime-mode";

const PAGE_SIZE = 50;
const fmtDate = (value: unknown) => { const date = new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? "Fecha no informada" : date.toLocaleString("es-PE"); };

export function ActivityView({ events, error, loading }: { events: AgentEvent[]; error: string; loading: boolean }) {
  const [audit, setAudit] = useState<ApiPage<OperationalItem>>({ items: [] });
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(!isLocalPreview);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const [search, setSearch] = useState("");

  async function loadAudit(nextCursor?: string) {
    if (isLocalPreview) { setAudit({ items: [] }); setAuditError(""); setAuditLoading(false); return; }
    setAuditLoading(true); setAuditError("");
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (nextCursor) query.set("cursor", nextCursor);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (type) query.set("eventType", type);
    if (status) query.set("status", status);
    if (errorOnly) query.set("error", "true");
    if (search.trim()) query.set("search", search.trim());
    try { setAudit(await auraApi.events(query)); }
    catch (reason) { setAudit({ items: [] }); setAuditError(toUserMessage(reason, "No pudimos cargar el historial de actividad.")); }
    finally { setAuditLoading(false); }
  }
  useEffect(() => { void loadAudit(); }, []);

  const eventTypes = useMemo(() => [...new Set(audit.items.map((event) => String(event.eventType ?? "")).filter(Boolean))].sort(), [audit.items]);
  const supervisorFiltered = useMemo(() => events.filter((event) => !search || `${event.eventId} ${event.taskId} ${event.executionId} ${event.eventType}`.toLowerCase().includes(search.toLowerCase())), [events, search]);
  function nextPage() { if (!audit.nextCursor || auditLoading) return; setCursorHistory((current) => [...current, cursor]); setCursor(audit.nextCursor); void loadAudit(audit.nextCursor); }
  function previousPage() { if (!cursorHistory.length || auditLoading) return; const prior = cursorHistory[cursorHistory.length - 1]; setCursorHistory((current) => current.slice(0, -1)); setCursor(prior); void loadAudit(prior); }

  return <section className="panel activity-audit">
    <span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">HISTORIAL DE ACTIVIDAD</div><h2>Actividad del sistema</h2>
    <p>Revisa los movimientos registrados y las tareas de supervisión más recientes.</p>
    <div className="module-toolbar activity-filters" aria-label="Filtros de actividad">
      <label className="module-search">Buscar por identificador o movimiento<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Incidente, máquina o tarea"/></label>
      <label className="module-search">Desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
      <label className="module-search">Hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
      <label className="module-search">Tipo<select value={type} onChange={(event) => setType(event.target.value)}><option value="">Todos los tipos</option>{eventTypes.map((eventType) => <option key={eventType} value={eventType}>{toEventLabel(eventType)}</option>)}</select></label>
      <label className="module-search">Estado<input value={status} onChange={(event) => setStatus(event.target.value)} placeholder="Estado de la tarea"/></label>
      <label><input type="checkbox" checked={errorOnly} onChange={(event) => setErrorOnly(event.target.checked)}/> Solo incidencias con error</label>
      <button onClick={() => { setCursor(undefined); setCursorHistory([]); void loadAudit(); }} disabled={auditLoading}>Aplicar filtros</button>
    </div>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>MOVIMIENTO</span><span>RECURSO</span><span>ESTADO</span><span>RESPONSABLE</span></div>
    {auditLoading ? <div className="table-message" role="status">Cargando historial…</div> : auditError ? <div className="table-message" role="alert">{auditError}<button className="module-link" onClick={() => void loadAudit(cursor)}><RefreshCw size={13}/> Volver a intentar</button></div> : audit.items.length ? <div className="event-rows">{[...audit.items].sort((a, b) => Date.parse(String(b.timestamp ?? b.createdAt)) - Date.parse(String(a.timestamp ?? a.createdAt))).map((event) => <article key={String(event.eventId ?? event.entityId)}><time>{fmtDate(event.timestamp ?? event.createdAt)}</time><b>{toEventLabel(String(event.eventType ?? event.entityType))}</b><code>{String(event.resourceId ?? event.entityId)}</code><span>{toStatusLabel(String(event.status ?? "Registrado"))}</span><span>{String(event.actor ?? "—")}</span></article>)}</div> : <div className="module-empty"><Activity size={18}/><b>{search || from || to || type || status || errorOnly ? "No encontramos movimientos con esos filtros" : "Todavía no hay actividad para mostrar"}</b><p>Prueba con otro intervalo o elimina algunos filtros.</p></div>}
    <div className="activity-pagination"><button onClick={previousPage} disabled={!cursorHistory.length || auditLoading}><ChevronLeft size={15}/> Anterior</button><span>Página {cursorHistory.length + 1} · {audit.items.length} movimientos</span><button onClick={nextPage} disabled={!audit.nextCursor || auditLoading}>Siguiente <ChevronRight size={15}/></button></div>
    <h3 className="module-subheading">Tareas de supervisión</h3>
    {loading ? <div className="table-message" role="status">Cargando tareas…</div> : error ? <div className="table-message" role="alert">{error}</div> : supervisorFiltered.length ? <div className="event-rows supervisor-events">{[...supervisorFiltered].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).map((event) => <article key={event.eventId}><time>{fmtDate(event.timestamp)}</time><b>{toEventLabel(event.eventType)}</b><code>{event.taskId.slice(0, 8)}</code><span>Registrada</span><span>Supervisión</span></article>)}</div> : <div className="module-empty"><p>Todavía no hay tareas de supervisión.</p></div>}
    <small>Se muestran movimientos registrados; no confirma el envío de avisos externos.</small>
  </section>;
}
