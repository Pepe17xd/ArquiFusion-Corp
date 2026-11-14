import { ArrowRight, CircleAlert, ShieldAlert } from "lucide-react";
import type { AppView } from "../../components/navigation/NavigationRail";
import { FleetMetricsStrip } from "../../components/telemetry/FleetMetricsStrip";
import { TelemetryPanel } from "../../components/telemetry/TelemetryPanel";
import { WorkflowPanel } from "../../components/agents/WorkflowPanel";
import { BrainEcosystem } from "../../components/agents/BrainEcosystem";
import type { FleetMetrics, Machine, OperationsOverview, RecommendationResult } from "../../services/api/client";
import { MachineTable } from "../fleet/FleetView";

export function CommandCenter({ metrics, machines, total, loading, result, intelligenceLoading, intelligenceError, overview, onRun, onNavigate, onOpenMachine }: {
  metrics: FleetMetrics | null; machines: Machine[]; total: number; loading: boolean;
  result: RecommendationResult | null; intelligenceLoading: boolean; intelligenceError?: string; onRun: () => void;
  overview: OperationsOverview | null;
  onNavigate: (view: AppView) => void; onOpenMachine: (id: string) => void;
}) {
  return <>
    <FleetMetricsStrip metrics={metrics} loading={loading}/>
    <BrainEcosystem loading={intelligenceLoading} completed={Boolean(result)} error={intelligenceError} onRun={onRun}/>
    <div className="command-grid">
      <WorkflowPanel result={result} loading={intelligenceLoading} onRun={onRun} onOpenAgents={() => onNavigate("agents")}/>
      <InsightsPanel result={result} onOpenMachine={onOpenMachine} onOpenAgents={() => onNavigate("agents")}/>
    </div>
    {overview && <section className="panel supervisor-summary">
      <div className="section-heading"><div><div className="eyebrow">SUPERVISIÓN</div><h2>Ejecuciones registradas</h2></div><button className="text-button" onClick={() => onNavigate("activity")}>Ver actividad</button></div>
      <div className="supervisor-counts"><span><b>{overview.tasks.pending}</b>En proceso</span><span><b>{overview.tasks.succeeded}</b>Completadas</span><span><b>{overview.tasks.failed}</b>Fallidas</span><span><b>{overview.agents.filter((agent) => agent.status === "operational").length}</b>Capacidades operativas</span></div>
    </section>}
    <TelemetryPanel machines={machines} total={total} loading={loading}/>
    <MachineTable machines={machines.slice(0, 6)} loading={loading} onOpen={onOpenMachine} title="Vista rápida de la flota" action={() => onNavigate("fleet")}/>
  </>;
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
