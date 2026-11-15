import { Activity, AlertTriangle, ArrowRight, BrainCircuit, Boxes, CheckCircle2, HardHat, Truck, Wrench } from "lucide-react";
import type { AppView } from "../../components/navigation/NavigationRail";
import type { AgentEvent, AgentTask, AuraKpis, FleetMetrics, Machine, OperationsOverview, RecommendationResult } from "../../services/api/client";
import { MachineTable } from "../fleet/FleetView";
import { IntelligenceWorkbench } from "../intelligence/IntelligenceWorkbench";
import "./command-center.css";

const taskLabel: Record<AgentTask["state"], string> = { PENDING: "Pendiente", QUEUED: "Pendiente", RUNNING: "En ejecución", RETRYING: "En ejecución", SUCCEEDED: "Completada", FAILED: "Fallida", DEAD_LETTER: "Fallida" };
const fmt = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "Fecha no informada";
const ago = (value: string) => { const ms = Date.now() - Date.parse(value); if (!Number.isFinite(ms) || ms < 0) return fmt(value); const mins = Math.floor(ms / 60000); return mins < 1 ? "ahora" : mins < 60 ? `hace ${mins} min` : mins < 1440 ? `hace ${Math.floor(mins / 60)} h` : `hace ${Math.floor(mins / 1440)} d`; };

export function CommandCenter({ metrics, metricsError, onRefresh, machines, loading, intelligenceLoading, intelligenceError, overview, kpis, task, tasks, events, tasksError, eventsError, selectedMachineId, onSelectMachine, lastUpdated, organization, recommendations, onRun, onRefreshTask, onNavigate, onOpenMachine }: {
  metrics: FleetMetrics | null; machines: Machine[]; loading: boolean; intelligenceLoading: boolean; intelligenceError?: string; onRun: () => void; onRefreshTask: () => void;
  metricsError: boolean; onRefresh: () => void;
  overview: OperationsOverview | null; kpis: AuraKpis | null; task: AgentTask | null; tasks: AgentTask[]; events: AgentEvent[]; tasksError: string; eventsError: string; selectedMachineId: string; onSelectMachine: (id: string) => void;
  lastUpdated: Date | null; organization: string; recommendations: RecommendationResult | null;
  onNavigate: (view: AppView) => void; onOpenMachine: (id: string) => void;
}) {
  const recentTasks = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4);
  const recentEvents = [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 5);
  const attention = metrics ? metrics.alert + metrics.stopped : undefined;
  const segments = metrics ? [
    { label: "Operativas", count: metrics.operational, color: "#36b86e" },
    { label: "Mantenimiento", count: metrics.maintenance, color: "#e8a943" },
    { label: "Atención", count: metrics.alert + metrics.stopped, color: "#e34143" },
  ] : [];
  const known = segments.reduce((sum, item) => sum + item.count, 0);
  if (metrics && metrics.total > known) segments.push({ label: "Otros estados", count: metrics.total - known, color: "#77777d" });
  let offset = 0;
  const donut = metrics?.total ? segments.map((item) => { const start = offset; offset += item.count / metrics.total * 100; return `${item.color} ${start}% ${offset}%`; }).join(", ") : "#28282c 0 100%";
  const openModule = (view: AppView) => () => onNavigate(view);

  return <div className="control-room">
    <section className="command-kpis" aria-label="Indicadores de flota">
      <Kpi icon={Truck} label="Equipos registrados" value={metrics?.total} loading={loading}/>
      <Kpi icon={CheckCircle2} label="Operativas" value={metrics?.operational} accent="success" loading={loading}/>
      <Kpi icon={Wrench} label="En mantenimiento" value={metrics?.maintenance} accent="warning" loading={loading}/>
      <Kpi icon={AlertTriangle} label="Requieren atención" value={attention} accent="danger" loading={loading}/>
      <article className="command-kpi availability-kpi"><span className="kpi-icon"><Activity size={18}/></span><div className="kpi-copy"><small>Disponibilidad</small><b>{loading ? "—" : metrics ? `${metrics.availabilityPercent.toFixed(1)}%` : "—"}</b><div className="availability-track"><i style={{ width: `${metrics ? Math.max(0, Math.min(100, metrics.availabilityPercent)) : 0}%` }}/></div></div></article>
    </section>
    {!loading && metricsError && <div className="dashboard-data-warning" role="alert"><span>No pudimos actualizar los indicadores.</span><button onClick={onRefresh}>Volver a intentar</button></div>}

    <section className="industrial-hero">
      <div className="hero-copy"><span className="hero-eyebrow"><i/> ARQUIFUSION / OPERACIONES</span><h1>Centro de mando</h1><p>Supervisa tu flota, anticipa incidentes y coordina operaciones desde una sola plataforma.</p><small>{organization}{lastUpdated ? ` · Actualizado ${fmt(lastUpdated.toISOString())}` : ""}</small>
        <div className="hero-actions"><button className="hero-primary" onClick={openModule("incidents")}>Registrar incidente <ArrowRight size={15}/></button><button className="hero-secondary" onClick={openModule("fleet")}>Ver flota</button></div>
      </div>
    </section>

    <section className="command-middle">
      <article className="dashboard-card fleet-state-card"><CardHeading eyebrow="ESTADO OPERATIVO" title="Estado de la flota" action="Ver flota" onAction={openModule("fleet")}/>
        {loading ? <div className="dashboard-empty">Cargando métricas de flota…</div> : metrics ? <div className="fleet-donut-layout"><div className="fleet-donut" style={{ background: `conic-gradient(${donut})` }} role="img" aria-label={`Distribución de ${metrics.total} equipos`}><div><b>{metrics.total.toLocaleString()}</b><small>equipos</small></div></div><div className="fleet-legend">{segments.map(({ label, count, color }) => <div key={label}><i style={{ background: color }}/><span>{label}</span><b>{count}</b><small>{metrics.total ? `${(count / metrics.total * 100).toFixed(0)}%` : "—"}</small></div>)}</div></div> : <div className="dashboard-empty">No hay datos de flota disponibles.</div>}
      </article>

      <AuraCore onNavigate={onNavigate} task={task}/>

      <article className="dashboard-card recent-activity-card"><CardHeading eyebrow="TRAZABILIDAD" title="Actividad reciente" action="Ver todo" onAction={openModule("activity")}/>
        {loading ? <div className="dashboard-empty">Cargando actividad…</div> : eventsError ? <div className="dashboard-error" role="alert">{eventsError}</div> : recentEvents.length ? <div className="event-timeline">{recentEvents.map((event) => <article key={event.eventId}><i className="timeline-dot"/><div><b>{event.eventType}</b><code>{event.taskId}</code><small>{ago(event.timestamp)} · {fmt(event.timestamp)}</small></div></article>)}</div> : <div className="dashboard-empty"><Activity size={18}/><b>Sin actividad registrada</b><span>Los movimientos recientes aparecerán aquí.</span></div>}
      </article>
    </section>

    <section className="command-bottom">
      <article className="dashboard-card recommendations-card"><CardHeading eyebrow="INTELIGENCIA OPERATIVA" title="Recomendaciones operativas"/><p className="card-description">Basadas en el análisis disponible de flota y las respuestas persistidas por el servicio.</p>
        {recommendations?.recommendations.length ? <><div className="recommendation-origin"><BrainCircuit size={14}/> {recommendations.source === "gemini-api" ? "Gemini" : "Reglas del sistema"}<small>Origen de la recomendación · {fmt(recommendations.generatedAt)}</small></div><div className="dashboard-recommendations">{recommendations.recommendations.slice(0, 3).map((item, index) => <article key={`${item.machineId}-${item.title}-${index}`}><div><span className={`priority-pill ${item.priority}`}>{item.priority === "high" ? "Alta" : "Media"}</span><code>{item.machineId}</code><b>{item.title}</b><p>{item.reason}</p><small>{item.suggestedAction}</small></div><button onClick={() => onOpenMachine(item.machineId)} aria-label={`Abrir máquina ${item.machineId}`}><ArrowRight size={15}/></button></article>)}</div></> : <div className="dashboard-empty recommendation-empty"><BrainCircuit size={19}/><b>{loading ? "Consultando recomendaciones…" : "No hay recomendaciones disponibles"}</b><span>Los resultados aparecerán aquí cuando haya un análisis disponible.</span><button className="hero-secondary" onClick={onRun} disabled={intelligenceLoading || !machines.length}>{intelligenceLoading ? "Analizando…" : "Solicitar análisis"}</button>{intelligenceError && <small className="dashboard-error" role="alert">{intelligenceError}</small>}</div>}
      </article>
      <article className="dashboard-card indicators-card"><CardHeading eyebrow="RENDIMIENTO" title="Indicadores clave"/><small className="indicator-period">Últimos 30 días</small>
        <div className="indicator-row"><span>MTTR</span><b>{kpis?.mttr.averageMinutes == null ? "—" : `${kpis.mttr.averageMinutes.toFixed(0)} min`}</b><small>{kpis ? `${kpis.mttr.resolvedIncidentCount} incidentes resueltos · ${fmt(kpis.period.from)} – ${fmt(kpis.period.to)}` : "Sin datos del periodo"}</small></div>
        <div className="indicator-row"><span>Reincidencia</span><b>{kpis?.recurrence.percent == null ? "—" : `${kpis.recurrence.percent.toFixed(1)}%`}</b><small>{kpis ? `${kpis.recurrence.recurrentIncidentCount} recurrentes de ${kpis.recurrence.incidentCount} · ventana ${kpis.recurrence.windowDays} días` : "Sin datos del periodo"}</small></div>
        <div className="indicator-row"><span>Disponibilidad</span><b>{loading || !metrics ? "—" : `${metrics.availabilityPercent.toFixed(1)}%`}</b><small>{metrics ? `${metrics.operational} de ${metrics.total} equipos operativos` : "Sin datos"}</small></div>
        {!loading && !overview && <p className="dashboard-empty">Resumen operativo no disponible.</p>}
      </article>
    </section>

    <section className="command-support-grid">
      <article className="dashboard-card support-card"><CardHeading eyebrow="SUPERVISIÓN" title="Tareas recientes" action="Centro de agentes" onAction={openModule("agents")}/>{loading ? <div className="dashboard-empty">Cargando tareas…</div> : tasksError ? <div className="dashboard-error" role="alert">{tasksError}</div> : recentTasks.length ? recentTasks.map((item) => <div className="support-list-row" key={item.taskId}><i className={`task-dot ${item.state.toLowerCase()}`}/><span><b>{taskLabel[item.state]}</b><small>{item.taskType} · {fmt(item.updatedAt)}</small></span><code>{item.taskId.slice(0, 8)}</code></div>) : <div className="dashboard-empty">No hay tareas registradas.</div>}</article>
      <article className="dashboard-card support-card"><CardHeading eyebrow="OPERACIÓN" title="Resumen de tareas"/>{overview ? <div className="overview-numbers"><span><b>{overview.tasks.pending}</b>Pendientes</span><span><b>{overview.tasks.failed}</b>Fallidas</span><span><b>{overview.tasks.succeeded}</b>Completadas</span></div> : <div className="dashboard-empty">Sin información para mostrar.</div>}</article>
    </section>

    <MachineTable machines={machines.slice(0, 6)} loading={loading} onOpen={onOpenMachine} title="Vista rápida de la flota" action={openModule("fleet")}/>
    <IntelligenceWorkbench machines={machines} selectedMachineId={selectedMachineId} onSelectMachine={onSelectMachine} task={task} busy={intelligenceLoading} error={intelligenceError || ""} onRun={onRun} onRefresh={onRefreshTask}/>
  </div>;
}

function Kpi({ icon: Icon, label, value, accent = "neutral", loading }: { icon: typeof Truck; label: string; value?: number; accent?: string; loading: boolean }) {
  return <article className={`command-kpi accent-${accent}`}><span className="kpi-icon"><Icon size={18}/></span><div className="kpi-copy"><small>{label}</small><b>{loading || value === undefined ? "—" : value.toLocaleString()}</b></div></article>;
}

function CardHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <header className="dashboard-card-heading"><div><small>{eyebrow}</small><h2>{title}</h2></div>{action && <button onClick={onAction}>{action}<ArrowRight size={13}/></button>}</header>;
}

function AuraCore({ onNavigate, task }: { onNavigate: (view: AppView) => void; task: AgentTask | null }) {
  const inputs: Array<[string, AppView, typeof Activity]> = [["Incidentes", "incidents", AlertTriangle], ["Datos de flota", "fleet", Truck], ["Inventario", "inventory", Boxes]];
  const outputs: Array<[string, AppView, typeof Activity]> = [["Mantenimiento", "maintenance", Wrench], ["Asignaciones", "orchestration", HardHat], ["Resultados", "agents", Activity]];
  const active = task && ["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(task.state);
  return <article className="dashboard-card aura-core-card"><CardHeading eyebrow="COORDINACIÓN" title="Núcleo de inteligencia AURA"/>
    <div className="aura-flow">
      <svg className="aura-connections" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="aura-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e5242d"/></marker></defs>{[54,150,246].map((y) => <g key={y}><path d={`M245 ${y} C330 ${y}, 350 150, 420 150`} markerEnd="url(#aura-arrow)"/><path d={`M580 150 C660 150, 675 ${y}, 755 ${y}`} markerEnd="url(#aura-arrow)"/></g>)}</svg>
      <div className="aura-node-list">{inputs.map(([label, view, Icon]) => <button key={label} onClick={() => onNavigate(view)}><Icon size={14}/><span>{label}</span><i/></button>)}</div>
      <div className={`aura-brain ${active ? "is-active" : ""}`}><div className="brain-orbit orbit-one"/><div className="brain-orbit orbit-two"/><BrainCircuit size={48}/><b>AURA</b><small>ANÁLISIS · RECOMENDACIÓN · ORQUESTACIÓN</small></div>
      <div className="aura-node-list">{outputs.map(([label, view, Icon]) => <button key={label} onClick={() => onNavigate(view)}><i/><Icon size={14}/><span>{label}</span></button>)}</div>
    </div>
    <div className="aura-status"><span className={`status-mark ${active ? "working" : task?.state === "FAILED" || task?.state === "DEAD_LETTER" ? "failed" : "idle"}`}/>{active ? "Análisis en curso" : task ? `Última tarea: ${taskLabel[task.state]}` : "A la espera de un análisis"}</div>
  </article>;
}
