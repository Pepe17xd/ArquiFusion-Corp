import { Activity, ArrowRight, BellRing, Clock3, Radio } from "lucide-react";
import type { AppView } from "../../components/navigation/NavigationRail";
import { FleetMetricsStrip } from "../../components/telemetry/FleetMetricsStrip";
import { TelemetryPanel } from "../../components/telemetry/TelemetryPanel";
import type { AgentEvent, AgentTask, FleetMetrics, Machine, OperationsOverview } from "../../services/api/client";
import { MachineTable } from "../fleet/FleetView";
import { IntelligenceWorkbench } from "../intelligence/IntelligenceWorkbench";
import "./command-center.css";

const taskLabel: Record<AgentTask["state"], string> = {
  PENDING: "Pendiente", QUEUED: "Pendiente", RUNNING: "En ejecución", RETRYING: "En ejecución",
  SUCCEEDED: "Completada", FAILED: "Fallida", DEAD_LETTER: "Fallida",
};

export function CommandCenter({ metrics, machines, total, loading, intelligenceLoading, intelligenceError, overview, task, tasks, events, tasksError, eventsError, selectedMachineId, onSelectMachine, connected, checking, lastUpdated, organization, onRun, onRefreshTask, onNavigate, onOpenMachine }: {
  metrics: FleetMetrics | null; machines: Machine[]; total: number; loading: boolean;
  intelligenceLoading: boolean; intelligenceError?: string; onRun: () => void; onRefreshTask: () => void;
  overview: OperationsOverview | null; task: AgentTask | null; tasks: AgentTask[]; events: AgentEvent[]; tasksError: string; eventsError: string;
  selectedMachineId: string; onSelectMachine: (id: string) => void;
  connected: boolean; checking: boolean; lastUpdated: Date | null; organization: string;
  onNavigate: (view: AppView) => void; onOpenMachine: (id: string) => void;
}) {
  const alerts = machines.filter((machine) => machine.status === "alert" || machine.status === "stopped").slice(0, 5);
  const recentTasks = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
  const recentEvents = [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 5);
  return <div className="control-room">
    <section className="control-header"><div><span className="control-overline"><Radio size={13}/> CENTRO DE INTELIGENCIA / OPERACIÓN</span><h2>{organization}</h2><p>Estado de la flota, ejecución de tareas y señales operativas desde la API.</p></div><div className="control-header-status"><span><i className={`origin-led ${connected ? "online" : checking ? "checking" : "offline"}`}/>{checking ? "Comprobando API" : connected ? "API conectada" : "API sin conexión"}</span><span><Clock3 size={13}/> Actualizado: {lastUpdated ? lastUpdated.toLocaleTimeString("es-PE") : "sin datos"}</span></div></section>

    <FleetMetricsStrip metrics={metrics} loading={loading}/>
    <IntelligenceWorkbench machines={machines} selectedMachineId={selectedMachineId} onSelectMachine={onSelectMachine} task={task} busy={intelligenceLoading} error={intelligenceError || ""} onRun={onRun} onRefresh={onRefreshTask}/>

    <div className="operations-grid">
      <section className="panel operations-panel"><div className="section-heading"><div><div className="eyebrow">ESTADO DE MÁQUINAS</div><h2>Alertas y equipos detenidos</h2></div><button className="text-button" onClick={() => onNavigate("fleet")}>Ver flota <ArrowRight size={14}/></button></div>
        {loading ? <div className="table-message">Cargando estado de flota…</div> : alerts.length ? <div className="operations-alert-list">{alerts.map((machine) => <button key={machine.machineId} onClick={() => onOpenMachine(machine.machineId)}><span className={`machine-alert-mark ${machine.status}`}>{machine.status === "alert" ? <BellRing size={15}/> : <Activity size={15}/>}</span><span><b>{machine.machineId}</b><small>{machine.model} · {machine.location}</small></span><em>{machine.status === "alert" ? "Alerta" : "Detenida"}</em></button>)}</div> : <p className="control-empty">No hay alertas ni máquinas detenidas en los registros recibidos.</p>}
      </section>

      <section className="panel operations-panel"><div className="section-heading"><div><div className="eyebrow">ORQUESTACIÓN</div><h2>Tareas recientes</h2></div></div>
        {loading ? <p className="control-empty" role="status">Cargando tareas…</p> : tasksError ? <p className="operations-error" role="alert">{tasksError}</p> : recentTasks.length ? <div className="operations-task-list">{recentTasks.map((item) => <article key={item.taskId}><span className={`task-dot ${item.state.toLowerCase()}`}/><div><b>{taskLabel[item.state]}</b><small>{item.taskType} · {new Date(item.updatedAt).toLocaleString("es-PE")}</small></div><code>{item.taskId.slice(0, 8)}</code></article>)}</div> : <p className="control-empty">No hay tareas registradas.</p>}
      </section>

      <section className="panel operations-panel events-panel"><div className="section-heading"><div><div className="eyebrow">SUPERVISIÓN</div><h2>Eventos recientes</h2></div><button className="text-button" onClick={() => onNavigate("activity")}>Ver actividad <ArrowRight size={14}/></button></div>
        {loading ? <p className="control-empty" role="status">Cargando eventos…</p> : eventsError ? <p className="operations-error" role="alert">{eventsError}</p> : recentEvents.length ? <div className="operations-event-list">{recentEvents.map((event) => <article key={event.eventId}><Activity size={14}/><div><b>{event.eventType}</b><small>{new Date(event.timestamp).toLocaleString("es-PE")}</small></div><code>{event.taskId.slice(0, 8)}</code></article>)}</div> : <p className="control-empty">No hay eventos registrados.</p>}
      </section>
      <section className="operations-overview-note"><span>RESUMEN DE OPERACIONES</span><b>{overview ? `${overview.tasks.pending} tareas activas · ${overview.tasks.failed} fallidas · ${overview.tasks.succeeded} completadas` : "Resumen no disponible"}</b><small>Señales derivadas del contrato de resumen de operaciones.</small></section>
    </div>

    <TelemetryPanel machines={machines} total={total} loading={loading}/>
    <MachineTable machines={machines.slice(0, 6)} loading={loading} onOpen={onOpenMachine} title="Vista rápida de la flota" action={() => onNavigate("fleet")}/>
  </div>;
}
