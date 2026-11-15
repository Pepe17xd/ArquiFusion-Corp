import { useMemo } from "react";
import { Activity, BrainCircuit, CircleAlert, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import type { AgentTask, Machine } from "../../services/api/client";
import { toUserMessage } from "../../services/api/user-message";
import "./intelligence-workbench.css";

const stateLabels: Record<AgentTask["state"], string> = {
  PENDING: "Pendiente", QUEUED: "Pendiente", RUNNING: "En ejecución", RETRYING: "En ejecución",
  SUCCEEDED: "Completada", FAILED: "Fallida", DEAD_LETTER: "Fallida",
};

export function IntelligenceWorkbench({ machines, selectedMachineId, onSelectMachine, task, busy, error, onRun, onRefresh }: {
  machines: Machine[];
  selectedMachineId: string;
  onSelectMachine: (id: string) => void;
  task: AgentTask | null;
  busy: boolean;
  error: string;
  onRun: () => void;
  onRefresh: () => void;
}) {
  const selectedMachine = useMemo(() => machines.find((machine) => machine.machineId === selectedMachineId), [machines, selectedMachineId]);
  const result = task?.result;
  const taskActive = Boolean(task && !["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state));

  return <section className="panel intelligence-workbench" aria-labelledby="intelligence-title">
    <header className="workbench-heading">
      <span className="workbench-icon"><BrainCircuit size={19}/></span>
      <div><span className="eyebrow">ANÁLISIS INTELIGENTE</span><h2 id="intelligence-title">Recomendaciones operativas</h2><p>Solicita una evaluación de flota y consulta el resultado de la tarea.</p></div>
      {task && <span className={`task-state state-${task.state.toLowerCase()}`}><i/>{stateLabels[task.state]}</span>}
    </header>

    <div className="workbench-controls">
      <label htmlFor="analysis-machine">Máquina de referencia</label>
      <select id="analysis-machine" value={selectedMachineId} onChange={(event) => onSelectMachine(event.target.value)} disabled={busy || machines.length === 0}>
        <option value="">Selecciona una máquina</option>
        {machines.map((machine) => <option key={machine.machineId} value={machine.machineId}>{machine.machineId} · {machine.model}</option>)}
      </select>
      <button className="button button-primary" onClick={onRun} disabled={busy || taskActive || !selectedMachineId}>
        {busy ? <><LoaderCircle size={15}/> Analizando…</> : taskActive ? <><Activity size={15}/> Tarea activa</> : <><Sparkles size={15}/> Analizar flota</>}
      </button>
      {task && <button className="button button-secondary" onClick={onRefresh} disabled={busy} aria-label="Actualizar estado de la tarea"><RefreshCw size={15}/> Actualizar</button>}
    </div>
    <p className="workbench-contract-note">El análisis considera la flota completa; el equipo seleccionado sirve como referencia.</p>

    {error && <div className="workbench-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button onClick={onRefresh} disabled={!task || busy}>Volver a consultar</button></div>}
    {!machines.length && <div className="workbench-empty">No hay máquinas disponibles para seleccionar.</div>}
    {task && <div className="task-summary">
      <div><small>TAREA</small><code>{task.taskId}</code></div>
      <div><small>ESTADO</small><b>{stateLabels[task.state]}</b></div>
      <div><small>ACTUALIZADA</small><b>{new Date(task.updatedAt).toLocaleString("es-PE")}</b></div>
      {task.error && <p className="task-error-detail">{toUserMessage(task.error.message, "La tarea no pudo completarse.")}</p>}
    </div>}
    {busy && <div className="workbench-progress" role="status"><Activity size={16}/> Consultando el estado de la tarea…</div>}
    {result && <div className="recommendation-results">
      <div className="recommendation-results-heading"><h3>Recomendaciones recibidas</h3><span>{result.recommendations.length} resultados</span></div>
      <div className="intelligence-source"><Sparkles size={14}/>{result.source === "gemini-api" ? "Gemini" : "Reglas deterministas"}<small>Origen indicado en el resultado · {new Date(result.generatedAt).toLocaleString("es-PE")}</small></div>
      {result.recommendations.length ? <div className="workbench-recommendations">{result.recommendations.map((recommendation, index) => <article key={`${recommendation.machineId}-${recommendation.title}-${index}`}>
        <div className="recommendation-topline"><span className={`priority priority-${recommendation.priority}`}>{recommendation.priority === "high" ? "Prioridad alta" : "Prioridad media"}</span><span>{recommendation.category === "maintenance" ? "Mantenimiento" : "Operaciones"}</span><code>{recommendation.machineId}</code></div>
        <h4>{recommendation.title}</h4><p>{recommendation.reason}</p><div className="recommendation-next-step">{recommendation.suggestedAction}</div>
        {Object.keys(recommendation.evidence).length > 0 && <dl>{Object.entries(recommendation.evidence).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
      </article>)}</div> : <div className="workbench-empty">La evaluación terminó sin recomendaciones.</div>}
    </div>}
    {task?.state === "SUCCEEDED" && !result && <div className="workbench-empty">La tarea terminó, pero la respuesta no contiene recomendaciones.</div>}
    {selectedMachine && <div className="selected-machine-note">Referencia seleccionada: <b>{selectedMachine.machineId}</b> · {selectedMachine.status}</div>}
  </section>;
}
