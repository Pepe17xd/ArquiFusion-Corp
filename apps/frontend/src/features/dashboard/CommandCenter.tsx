import { Activity, ArrowRight, CircleAlert, Clock3, Radio, ShieldAlert } from "lucide-react";
import type { AppView } from "../../components/navigation/NavigationRail";
import { FleetMetricsStrip } from "../../components/telemetry/FleetMetricsStrip";
import { TelemetryPanel } from "../../components/telemetry/TelemetryPanel";
import { WorkflowPanel } from "../../components/agents/WorkflowPanel";
import { BrainEcosystem } from "../../components/agents/BrainEcosystem";
import type { AgentTask, FleetMetrics, Machine, OperationsOverview, RecommendationResult } from "../../services/api/client";
import { MachineTable } from "../fleet/FleetView";
import "./command-center.css";

export function CommandCenter({ metrics, machines, total, loading, result, intelligenceLoading, intelligenceError, overview, task, connected, checking, lastUpdated, organization, onRun, onNavigate, onOpenMachine }: {
  metrics: FleetMetrics | null; machines: Machine[]; total: number; loading: boolean;
  result: RecommendationResult | null; intelligenceLoading: boolean; intelligenceError?: string; onRun: () => void;
  overview: OperationsOverview | null;
  task: AgentTask | null; connected: boolean; checking: boolean; lastUpdated: Date | null; organization: string;
  onNavigate: (view: AppView) => void; onOpenMachine: (id: string) => void;
}) {
  return <div className="control-room">
    <section className="control-header"><div><span className="control-overline"><Radio size={13}/> CENTRO DE INTELIGENCIA / OPERACIÓN</span><h2>{organization}</h2><p>Visibilidad de flota y orquestación basada en datos disponibles.</p></div><div className="control-header-status"><span><i className={`origin-led ${connected ? "online" : checking ? "checking" : "offline"}`}/>{checking ? "Comprobando API" : connected ? "API conectada" : "API sin conexión"}</span><span><Clock3 size={13}/> Actualización: {lastUpdated ? lastUpdated.toLocaleTimeString("es-PE") : "sin datos"}</span></div></section>
    <FleetMetricsStrip metrics={metrics} loading={loading}/>
    <div className="control-main"><BrainEcosystem loading={intelligenceLoading} completed={Boolean(result)} error={intelligenceError} onRun={onRun}/><div className="control-side">
      <InsightsPanel result={result} onOpenMachine={onOpenMachine} onOpenAgents={() => onNavigate("agents")}/>
      <section className="control-events"><div className="control-section-heading"><div><span>SUPERVISIÓN</span><h2>Actividad reciente</h2></div><button className="text-button" onClick={() => onNavigate("activity")}>Ver actividad <ArrowRight size={14}/></button></div>{overview ? overview.recentEvents.length ? <div className="control-event-list">{overview.recentEvents.slice(0, 4).map(event => <div key={event.eventId}><Activity size={14}/><div><b>{event.eventType}</b><small>{new Date(event.timestamp).toLocaleString("es-PE")}</small></div><code>{event.taskId.slice(0, 8)}</code></div>)}</div> : <p className="control-empty">No hay eventos registrados.</p> : <p className="control-empty">Actividad no disponible desde la API.</p>}</section></div></div>
    <div className="control-automation"><WorkflowPanel result={result} loading={intelligenceLoading} onRun={onRun} onOpenAgents={() => onNavigate("agents")}/><TaskTrace task={task} error={intelligenceError}/></div>
    <TelemetryPanel machines={machines} total={total} loading={loading}/>
    <MachineTable machines={machines.slice(0, 6)} loading={loading} onOpen={onOpenMachine} title="Vista rápida de la flota" action={() => onNavigate("fleet")}/>
  </div>;
}

function TaskTrace({ task, error }: { task: AgentTask | null; error?: string }) {
  const stages = ["Solicitud", "Orquestación", "Ejecución", "Resultado"];
  const state = task?.state;
  const current = state === "SUCCEEDED" ? 3 : state === "RUNNING" || state === "RETRYING" ? 2 : state === "QUEUED" ? 1 : 0;
  const failed = state === "FAILED" || state === "DEAD_LETTER" || Boolean(error);
  return <section className="control-trace"><div className="control-section-heading"><div><span>AUTOMATIZACIÓN / TAREA</span><h2>Seguimiento de ejecución</h2></div><span className={failed ? "trace-error" : "trace-status"}>{state || (error ? "ERROR" : "SIN EJECUCIÓN")}</span></div><p>Estados reportados por la API. La secuencia no confirma por sí sola un despliegue de Step Functions.</p><div className="trace-steps">{stages.map((stage, index) => <div key={stage} className={task && index <= current ? "reached" : ""}><i>{index + 1}</i><span>{stage}</span></div>)}</div>{task ? <dl><div><dt>Tarea</dt><dd>{task.taskId}</dd></div><div><dt>Ejecución</dt><dd>{task.executionId}</dd></div><div><dt>Actualizada</dt><dd>{new Date(task.updatedAt).toLocaleString("es-PE")}</dd></div><div><dt>Resultado</dt><dd>{task.result ? `${task.result.recommendations.length} recomendaciones` : task.error?.message || "Pendiente"}</dd></div></dl> : <p className="control-empty">{error || "Ejecuta la evaluación para consultar su estado e identificadores."}</p>}</section>;
}

function InsightsPanel({ result, onOpenMachine, onOpenAgents }: {
  result: RecommendationResult | null; onOpenMachine: (id: string) => void; onOpenAgents: () => void;
}) {
  return <section className="panel insights-panel">
    <div className="section-heading">
      <div><div className="eyebrow">HALLAZGOS OPERACIONALES</div><h2>Hallazgos con evidencia</h2></div>
      <button className="text-button" onClick={onOpenAgents}>Evaluación <ArrowRight size={14}/></button>
    </div>
    {result?.recommendations.length ? <div className="insight-list">
      {result.recommendations.slice(0, 3).map((item, index) => <article className="insight-item" key={`${item.machineId}-${item.title}-${index}`}>
        <span className={`severity-mark ${item.priority}`}><CircleAlert size={15}/></span>
        <div>
          <div className="insight-meta"><span>{item.priority === "high" ? "ALTA" : "MEDIA"}</span><button onClick={() => onOpenMachine(item.machineId)}>{item.machineId}</button></div>
          <h3>{item.title}</h3><p>{item.reason}</p>
          <div className="evidence-row">{Object.entries(item.evidence).map(([key, value]) => <span key={key}>{({ temperature: "Temperatura", vibration: "Vibración", status: "Estado" }[key] || key)}: <b>{value}</b></span>)}</div>
          <div className="recommendation-action">{item.suggestedAction}</div>
        </div>
      </article>)}
    </div> : <div className="empty-insights"><ShieldAlert size={20}/><b>{result ? "Sin hallazgos en el estado actual de la flota" : "Esperando el resultado de inteligencia"}</b><span>Las reglas revisan el estado, la temperatura y la vibración informados. No se agregan hallazgos sin datos que los respalden.</span></div>}
    <div className="origin-note">ORIGEN · {result ? "reglas deterministas" : "pendiente"} {result?.generatedAt && <span>· {new Date(result.generatedAt).toLocaleTimeString("es-PE")}</span>}</div>
  </section>;
}
