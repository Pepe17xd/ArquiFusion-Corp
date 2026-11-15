import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { AgentEvent, ApiPage, OperationalItem } from "../../services/api/client";
import { auraApi } from "../../services/api/client";

const PAGE_SIZE = 50;
export function ActivityView({ events, error, loading }: { events: AgentEvent[]; error: string; loading: boolean }) {
  const [audit, setAudit] = useState<ApiPage<OperationalItem>>({ items: [] });
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const [search, setSearch] = useState("");

  async function loadAudit(nextCursor?: string) {
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
    catch (reason) { setAudit({ items: [] }); setAuditError(reason instanceof Error ? reason.message : "No se pudo consultar la auditoría."); }
    finally { setAuditLoading(false); }
  }
  useEffect(() => { void loadAudit(); }, []);

  const eventTypes = useMemo(() => [...new Set(audit.items.map((event) => String(event.eventType ?? "" )).filter(Boolean))].sort(), [audit.items]);
  const filtered = audit.items;
  const supervisorFiltered = useMemo(() => events.filter((event) => !search || `${event.eventId} ${event.taskId} ${event.executionId} ${event.eventType}`.toLowerCase().includes(search.toLowerCase())), [events, search]);

  function nextPage() {
    if (!audit.nextCursor || auditLoading) return;
    setCursorHistory((current) => [...current, cursor]); setCursor(audit.nextCursor); void loadAudit(audit.nextCursor);
  }
  function previousPage() {
    if (!cursorHistory.length || auditLoading) return;
    const prior = cursorHistory[cursorHistory.length - 1]; setCursorHistory((current) => current.slice(0, -1)); setCursor(prior); void loadAudit(prior);
  }

  return <section className="panel activity-audit">
    <span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">AUDITORÍA DE OPERACIONES</div><h2>Actividad del sistema</h2>
    <p>Eventos persistidos por AURA en páginas del backend y eventos de ejecución devueltos por Supervisor.</p>
    <div className="module-toolbar activity-filters" aria-label="Filtros de actividad">
      <label className="module-search">Buscar identificador o evento<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Incidente, máquina, ejecución…"/></label>
      <label className="module-search">Desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
      <label className="module-search">Hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
      <label className="module-search">Tipo<select value={type} onChange={(event) => setType(event.target.value)}><option value="">Todos los tipos</option>{eventTypes.map((eventType) => <option key={eventType}>{eventType}</option>)}</select></label>
      <label className="module-search">Estado / error<input value={status} onChange={(event) => setStatus(event.target.value)} placeholder="completed, failed…"/></label>
      <label><input type="checkbox" checked={errorOnly} onChange={(event) => setErrorOnly(event.target.checked)}/> Solo errores</label>
      <button onClick={() => { setCursor(undefined); setCursorHistory([]); void loadAudit(); }} disabled={auditLoading}>Aplicar filtros</button>
    </div>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>EVENTO</span><span>RECURSO</span><span>ESTADO / DETALLE</span><span>ACTOR / EVIDENCIA</span></div>
    {auditLoading ? <div className="table-message" role="status">Cargando auditoría…</div> : auditError ? <div className="table-message" role="alert">{auditError}<button className="module-link" onClick={() => void loadAudit(cursor)}><RefreshCw size={13}/> Reintentar</button></div> : filtered.length ? <div className="event-rows">{[...filtered].sort((a, b) => Date.parse(String(b.timestamp ?? b.createdAt)) - Date.parse(String(a.timestamp ?? a.createdAt))).map((event) => { const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {}; return <article key={String(event.eventId ?? event.entityId)}><time>{new Date(String(event.timestamp ?? event.createdAt)).toLocaleString("es-PE")}</time><b>{String(event.eventType ?? event.entityType)}</b><code>{String(event.resourceId ?? event.entityId)}</code><span>{String(event.status ?? payload.status ?? "registrado")}</span><details><summary>Ver detalle</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details></article>; })}</div> : <div className="module-empty"><Activity size={18}/><b>{audit.items.length ? "Sin resultados para estos filtros" : "Sin eventos de auditoría"}</b><p>Los filtros se aplican a la página consultada. Cambia de página para explorar el resto del historial.</p></div>}
    <div className="activity-pagination"><button onClick={previousPage} disabled={!cursorHistory.length || auditLoading}><ChevronLeft size={15}/> Anterior</button><span>{cursorHistory.length + 1} · {audit.items.length} registros filtrados</span><button onClick={nextPage} disabled={!audit.nextCursor || auditLoading}>Siguiente <ChevronRight size={15}/></button></div>
    <h3 className="module-subheading">Ejecuciones Supervisor</h3>
    {loading ? <div className="table-message" role="status">Cargando eventos de ejecución…</div> : error ? <div className="table-message" role="alert">{error}</div> : supervisorFiltered.length ? <div className="event-rows supervisor-events">{[...supervisorFiltered].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).map((event) => <article key={event.eventId}><time>{new Date(event.timestamp).toLocaleString("es-PE")}</time><b>{event.eventType}</b><code>{event.taskId.slice(0, 8)}</code><span>{String(event.payload.state ?? event.payload.resultCount ?? "registrado")}</span><span>{String(event.payload.agentId ?? event.source)}</span></article>)}</div> : <div className="module-empty"><p>Aún no hay eventos de ejecución.</p></div>}
    <small>Los registros corresponden a APIs de auditoría y Supervisor; no se presentan como logs de CloudWatch. El backend pagina por tenant; filtros aplican a la página cargada.</small>
  </section>;
}
