import { ArrowUpRight, CirclePlay, CircleStop, Clock3, GitBranch, LoaderCircle, RotateCw } from "lucide-react";
import type { RecommendationResult } from "../../services/api/client";
import { Skeleton } from "../feedback/FeedbackBanner";

export function WorkflowPanel({ result, loading, onRun, onOpenAgents }: {
  result: RecommendationResult | null; loading: boolean; onRun: () => void; onOpenAgents: () => void;
}) {
  const generatedAt = result ? new Date(result.generatedAt) : undefined;
  return (
    <section className="panel workflow-panel">
      <div className="panel-heading">
          <div className="panel-title-stack"><div className="eyebrow">TAREA / fleet.recommendations</div><h2>Evaluación de flota</h2><p>La fuente del análisis aparece en el resultado de la API.</p></div>
        <button className="icon-button panel-link" aria-label="Abrir centro de agentes" onClick={onOpenAgents}><ArrowUpRight size={16}/></button>
      </div>
      <div className={"workflow-canvas" + (loading ? " evaluating" : "")} role="img" aria-label="Flujo de tarea: la API recibe una solicitud de recomendaciones de flota y devuelve un resultado estructurado">
        <div className="workflow-grid"/>
        <svg className="workflow-lines" viewBox="0 0 740 190" preserveAspectRatio="none" aria-hidden="true">
          <path className="flow-track" d="M126 94H302M438 94H614"/>
          <path className="flow-pulse" d="M126 94H302M438 94H614"/>
        </svg>
        <div className="workflow-node input-node"><span className="node-symbol"><GitBranch size={16}/></span><small>ENTRADA</small><b>Registros de flota</b><span className="node-caption">Estado y lecturas actuales</span></div>
        <div className="workflow-node assess-node"><span className="node-symbol assess-symbol"><RotateCw size={16}/></span><small>ANÁLISIS</small><b>Inteligencia</b><span className="node-caption">Fuente reportada por API</span></div>
        <div className="workflow-node output-node"><span className="node-symbol output-symbol"><CirclePlay size={16}/></span><small>SALIDA ESTRUCTURADA</small><b>Recomendaciones</b><span className="node-caption">Con evidencia</span></div>
        <div className="workflow-legend"><span><i className="legend-cyan"/>estado</span><span><i className="legend-ice"/>temperatura</span><span><i className="legend-amber"/>vibración</span></div>
      </div>
      <div className="workflow-footer">
        <div className="workflow-run-meta">
          <span className={"execution-indicator" + (loading ? " is-running" : "")}>{loading ? <LoaderCircle size={13}/> : <CircleStop size={13}/>}</span>
          <span><small>ÚLTIMA EJECUCIÓN</small><b>{loading ? "Evaluando la flota…" : generatedAt ? generatedAt.toLocaleString("es-PE") : "Sin ejecutar en esta sesión"}</b></span>
        </div>
        <span className="nonpersistent-note"><Clock3 size={12}/> Solo esta sesión</span>
        <button className="button button-primary run-button" disabled={loading} onClick={onRun}>{loading ? "En ejecución" : "Ejecutar evaluación"}</button>
      </div>
      {result && <div className="workflow-result"><span className="source-tag">{result.source === "gemini-api" ? "Gemini API" : "Reglas deterministas"}</span><span>{result.recommendations.length} recomendaciones recibidas</span><span className="text-separator">·</span><span>Origen informado por el backend</span></div>}
    </section>
  );
}

export function WorkflowSkeleton() {
  return <section className="panel workflow-panel"><div className="panel-heading"><div><div className="eyebrow">LANGGRAPH / WORKFLOW 01</div><h2>Evaluación de flota</h2></div></div><div className="workflow-placeholder"><Skeleton/><Skeleton/><Skeleton/></div></section>;
}
