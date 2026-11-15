import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, Check, Circle, Clock3, RefreshCw, Sparkles } from "lucide-react";
import { auraApi, operationsApi, type ApiPage, type AuraAssignment, type AuraKpis, type AuraTechnician, type InventoryBalance, type InventoryPart, type OperationalItem } from "../../services/api/client";
import type { AppView } from "../../components/navigation/NavigationRail";
import { moduleLoadState, moduleUnavailable } from "./module-state";

type Data = { incidents?: ApiPage<OperationalItem>; orders?: ApiPage<OperationalItem>; technicians?: ApiPage<AuraTechnician>; parts?: ApiPage<InventoryPart>; stock?: ApiPage<InventoryBalance>; alerts?: ApiPage<Record<string, unknown>>; assignments?: ApiPage<AuraAssignment>; events?: ApiPage<OperationalItem>; kpis?: AuraKpis };
const titles: Partial<Record<AppView, string>> = { maintenance: "Órdenes de mantenimiento", inventory: "Inventario y disponibilidad", technicians: "Equipo técnico", incidents: "Incidentes activos", orchestration: "Coordinación AURA" };

export function OperationalModule({ view, onNavigate }: { view: AppView; onNavigate: (view: AppView) => void }) {
  const [data, setData] = useState<Data>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [optimizing, setOptimizing] = useState(false);
  const [result, setResult] = useState<{ assignments: AuraAssignment[]; totalCost: number; workflowStarted: boolean; replayed: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const idempotency = useRef<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      let next: Data;
      if (view === "incidents") next = { incidents: await operationsApi.incidents() };
      else if (view === "maintenance") next = { orders: await operationsApi.maintenance() };
      else if (view === "technicians") next = { technicians: await auraApi.technicians() };
      else if (view === "inventory") {
        const values = await Promise.all([auraApi.parts(), auraApi.stock(), auraApi.inventoryAlerts()]);
        next = { parts: values[0], stock: values[1], alerts: values[2] };
      } else if (view === "orchestration") {
        const to = new Date(), from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
        const values = await Promise.all([auraApi.assignments(), auraApi.events(), auraApi.kpis(from.toISOString(), to.toISOString())]);
        next = { assignments: values[0], events: values[1], kpis: values[2] };
      } else next = {};
      setData(next);
    } catch (reason) {
      setData({});
      setError(reason instanceof Error ? reason.message : "No se pudo consultar el módulo.");
    } finally { setLoading(false); }
  }, [view]);
  useEffect(() => { void load(); setSelected([]); setResult(null); idempotency.current = null; }, [load]);
  const incidents = data.incidents?.items ?? [];
  const filtered = useMemo(() => incidents.filter((item) => (item.entityId + " " + (item.machineId ?? "") + " " + (item.title ?? "")).toLowerCase().includes(search.toLowerCase())), [incidents, search]);
  const unavailable = moduleUnavailable(error);
  const recordCount = view === "incidents" ? incidents.length : view === "maintenance" ? data.orders?.items.length ?? 0 : view === "technicians" ? data.technicians?.items.length ?? 0 : view === "inventory" ? data.stock?.items.length ?? 0 : data.assignments?.items.length ?? 0;
  const state = moduleLoadState({ loading, error, recordCount });
  async function optimize() {
    if (!selected.length || optimizing) return;
    setOptimizing(true); setError(""); idempotency.current ??= crypto.randomUUID();
    try {
      const response = await auraApi.optimize(selected, idempotency.current);
      setResult(response); idempotency.current = null; setSelected([]); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo coordinar la asignación."); }
    finally { setOptimizing(false); }
  }
  return <section className="module-shell" aria-labelledby="module-title">
    <header className="module-header"><div><span className="module-kicker"><Activity size={13}/> OPERACIONES / {view.toUpperCase()}</span><h2 id="module-title">{titles[view] ?? "Operaciones"}</h2><p>Datos de API autenticada. El estado vacío se diferencia de una API aún no desplegada.</p></div><button className="module-refresh" onClick={() => void load()} disabled={loading} aria-label="Actualizar módulo"><RefreshCw size={15}/><span>Actualizar</span></button></header>
    {error && <div className={"module-banner " + (unavailable ? "module-banner-warn" : "module-banner-error")} role="alert"><AlertTriangle size={17}/><div><b>{unavailable ? "API de este módulo aún no disponible" : "No se pudo cargar la información"}</b><p>{unavailable ? "Operations o AURA todavía no está desplegado en el API Gateway. No se muestran datos de ejemplo." : error}</p></div><button onClick={() => void load()}>Reintentar</button></div>}
    {state === "loading" ? <div className="module-skeleton" role="status" aria-label="Cargando módulo"><i/><i/><i/></div> : state !== "error" && <>
      {view === "incidents" && <>
        <div className="module-toolbar"><label className="module-search">Buscar incidente<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, máquina o título"/></label><span>{incidents.length} registros recibidos</span><button className="module-primary" onClick={() => void optimize()} disabled={!selected.length || optimizing}><Sparkles size={15}/>{optimizing ? "Calculando…" : "Asignar con AURA" + (selected.length ? " · " + selected.length : "")}</button></div>
        {result && <div className="module-result" role="status"><Sparkles size={16}/><span><b>Asignación optimizada</b> · costo global {result.totalCost.toFixed(3)} · {result.workflowStarted ? "workflow iniciado" : "workflow no iniciado: servicio no configurado"}{result.replayed ? " · respuesta idempotente" : ""}</span></div>}
        <div className="module-table-wrap"><table className="module-table"><thead><tr><th>Coordinar</th><th>Incidente</th><th>Máquina</th><th>Severidad</th><th>Estado</th><th>Creado</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.entityId}><td><input type="checkbox" aria-label={"Seleccionar " + item.entityId} checked={selected.includes(item.entityId)} disabled={!["open", "acknowledged"].includes(String(item.status))} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.entityId] : current.filter((id) => id !== item.entityId))}/></td><td><b>{item.title || item.entityId}</b><small>{item.entityId}</small></td><td>{item.machineId || "—"}</td><td><Pill value={item.severity ?? "Sin severidad"}/></td><td><Pill value={item.status ?? "unknown"}/></td><td>{dateLabel(item.createdAt)}</td></tr>)}</tbody></table>{!filtered.length && <Empty text={incidents.length ? "No hay coincidencias para la búsqueda." : "No hay incidentes en los registros recibidos."}/>}</div>
      </>}
      {view === "maintenance" && <Table items={data.orders?.items ?? []} headers={["Orden", "Máquina", "Prioridad", "Estado", "Actualizada"]} empty="No hay órdenes de mantenimiento en los registros recibidos." render={(item) => [<><b>{String(item.title ?? item.entityId)}</b><small>{item.entityId}</small></>, String(item.machineId ?? "—"), String(item.priority ?? "—"), <Pill value={item.status ?? "unknown"}/>, dateLabel(item.updatedAt)]}/>}
      {view === "technicians" && <>
        <div className="module-metrics"><Metric label="Técnicos" value={String(data.technicians?.items.length ?? 0)}/><Metric label="Disponibles" value={String(data.technicians?.items.filter((item) => item.availability === "available").length ?? 0)}/><Metric label="Habilidades" value={String(new Set(data.technicians?.items.flatMap((item) => item.skills.map((skill) => skill.code)) ?? []).size)}/></div>
        <Table items={(data.technicians?.items ?? []) as unknown as OperationalItem[]} headers={["Técnico", "Disponibilidad", "Especialidades", "Habilidades", "Capacidad"]} empty="No hay perfiles de técnico registrados." render={(item) => { const tech = item as unknown as AuraTechnician; return [<><b>{tech.displayName}</b><small>{tech.technicianId}</small></>, <Pill value={tech.availability}/>, tech.specialties.join(" · "), tech.skills.map((skill) => skill.code + " L" + skill.level).join(" · "), String(tech.maxConcurrentAssignments)]; }}/>
      </>}
      {view === "inventory" && <>
        <div className="module-metrics"><Metric label="Repuestos" value={String(data.parts?.items.length ?? 0)}/><Metric label="Ubicaciones" value={String(new Set(data.stock?.items.map((item) => item.locationId) ?? []).size)}/><Metric label="Alertas bajo mínimo" value={String(data.alerts?.items.length ?? 0)} tone={data.alerts?.items.length ? "warning" : ""}/></div>
        {!!data.alerts?.items.length && <div className="inventory-alerts">{data.alerts.items.map((item, index) => <article key={String(item.partId) + index}><AlertTriangle size={15}/><b>{String(item.name ?? item.partId)}</b><span>{String(item.locationId)} · disponible {String(item.available)} / mínimo {String(item.minimumStock)}</span></article>)}</div>}
        <Table items={(data.stock?.items ?? []) as unknown as OperationalItem[]} headers={["Repuesto", "SKU", "Ubicación", "En mano", "Reservado", "Disponible"]} empty="No hay saldos de inventario registrados." render={(item) => { const part = data.parts?.items.find((row) => row.partId === item.partId); return [<><b>{part?.name ?? String(item.partId)}</b><small>{String(item.partId)}</small></>, part?.sku ?? "—", String(item.locationId), String(item.onHand), String(item.reserved), String(Number(item.onHand) - Number(item.reserved))]; }}/>
      </>}
      {view === "orchestration" && <>
        <div className="module-metrics"><Metric label="MTTR · 30 días" value={data.kpis?.mttr.averageMinutes == null ? "—" : Math.round(data.kpis.mttr.averageMinutes) + " min"}/><Metric label="Reincidencia · ventana 30 días" value={data.kpis?.recurrence.percent == null ? "—" : data.kpis.recurrence.percent + "%"}/><Metric label="Downtime" value={data.kpis?.downtime.totalMinutes == null ? "No disponible" : Math.round(data.kpis.downtime.totalMinutes) + " min"}/></div>
        <div className="workflow-summary"><div><span>ASIGNACIONES</span><b>{data.assignments?.items.length ?? 0}</b></div><div><span>EN ATENCIÓN</span><b>{data.assignments?.items.filter((item) => item.status === "in_progress").length ?? 0}</b></div><div><span>EVENTOS AURA</span><b>{data.events?.items.length ?? 0}</b></div></div>
        <div className="workflow-list">{data.assignments?.items.map((assignment) => <WorkflowCard key={assignment.assignmentId} assignment={assignment} onOpenIncidents={() => onNavigate("incidents")}/>) ?? null}{!data.assignments?.items.length && <Empty text="No hay workflows de asignación en los registros recibidos."/>}</div>
        <div className="module-subheading"><h3>Eventos persistidos</h3><span>Notificación solicitada no confirma entrega.</span></div><Timeline items={data.events?.items ?? []}/>
      </>}
    </>}
  </section>;
}

function Table({ items, headers, empty, render }: { items: OperationalItem[]; headers: string[]; empty: string; render: (item: OperationalItem) => React.ReactNode[] }) {
  return <div className="module-table-wrap"><table className="module-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{items.map((item) => <tr key={item.entityId}>{render(item).map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table>{!items.length && <Empty text={empty}/>}</div>;
}
function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <article className={"module-metric " + tone}><span>{label}</span><b>{value}</b></article>; }
function Empty({ text }: { text: string }) { return <div className="module-empty"><Circle size={18}/><p>{text}</p></div>; }
function Pill({ value }: { value: string }) { const labels: Record<string, string> = { open: "Abierto", acknowledged: "Atendido", resolved: "Resuelto", planned: "Planificado", in_progress: "En progreso", completed: "Completado", cancelled: "Cancelado", proposed: "Esperando confirmación", accepted: "Aceptado", escalated: "Escalado", unassigned: "Sin asignar", available: "Disponible", unavailable: "No disponible" }; return <span className={"module-pill " + value}>{labels[value] ?? value}</span>; }
function dateLabel(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }) : "—"; }
function WorkflowCard({ assignment, onOpenIncidents }: { assignment: AuraAssignment; onOpenIncidents: () => void }) {
  const steps = ["proposed", "accepted", "in_progress", "completed"], current = steps.indexOf(assignment.status), failed = ["escalated", "unassigned"].includes(assignment.status);
  return <article className="workflow-card"><div className="workflow-card-head"><div><span className="module-kicker">INCIDENTE {assignment.incidentId}</span><h3>{assignment.machineId}</h3></div><Pill value={assignment.status}/></div><div className="workflow-steps" aria-label={"Estado del workflow: " + assignment.status}>{["Propuesta", "Confirmación", "Intervención", "Cierre"].map((label, index) => <div key={label} className={index < current ? "step-done" : index === current ? "step-active" : ""}><span>{index < current ? <Check size={12}/> : index + 1}</span><small>{label}</small></div>)}</div><div className="workflow-card-foot"><span>Técnico: {assignment.technicianId ?? "Sin asignar"}</span><span>Costo global {Number(assignment.cost).toFixed(3)}{assignment.distanceKm === undefined ? " · distancia omitida" : " · " + assignment.distanceKm.toFixed(1) + " km"}</span>{failed && <button onClick={onOpenIncidents}>Revisar incidente <ArrowRight size={13}/></button>}</div><div className="assignment-cost-factors">{Object.entries(assignment.costBreakdown ?? {}).map(([factor, value]) => <span key={factor}>{factor}: {Number(value).toFixed(2)}</span>)}</div></article>;
}
function Timeline({ items }: { items: OperationalItem[] }) { return <div className="module-timeline">{items.map((item) => <article key={item.entityId}><span className="timeline-mark"><Clock3 size={12}/></span><div><b>{String(item.eventType ?? item.entityId)}</b><p>{String(item.resourceId ?? item.machineId ?? "Evento operativo")}</p><small>{dateLabel(String(item.timestamp ?? item.createdAt))}</small></div><span className="timeline-status">Persistido</span></article>)}{!items.length && <Empty text="No hay eventos AURA registrados."/>}</div>; }
