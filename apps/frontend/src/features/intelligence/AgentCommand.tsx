import { useState } from "react";
import { Clock3 } from "lucide-react";
import { AgentStatusBadge } from "../../components/ui/StatusBadge";
import { MascotMark, type AgentRole } from "../../components/agents/MascotMark";
import { WorkflowPanel } from "../../components/agents/WorkflowPanel";
import type { Machine, RecommendationResult } from "../../services/api/client";
import type { AgentTask } from "../../services/api/client";
import { IntelligenceWorkbench } from "./IntelligenceWorkbench";

const agents: { id: AgentRole; name: string; role: string; desc: string; specialty: string }[] = [
  { id: "coordinator", name: "Agente coordinador", role: "Organización del ecosistema", specialty: "Coordinación", desc: "Reunirá prioridades y recomendaciones de las distintas especialidades." },
  { id: "maintenance", name: "Agente de mantenimiento predictivo", role: "Patrones de desgaste y fallos", specialty: "Mantenimiento", desc: "Ayudará a reconocer señales de desgaste cuando haya registros suficientes." },
  { id: "fleet", name: "Agente de operaciones de flota", role: "Actividad y productividad", specialty: "Operaciones", desc: "Aportará contexto sobre la actividad y el uso de los equipos." },
  { id: "inventory", name: "Agente de inteligencia de inventario", role: "Repuestos y existencias", specialty: "Repuestos", desc: "Relacionará la disponibilidad de repuestos con las necesidades de mantenimiento." },
  { id: "technicians", name: "Agente de asignación de técnicos", role: "Especialistas y carga de trabajo", specialty: "Personal", desc: "Facilitará la coordinación entre especialidades y trabajos pendientes." },
  { id: "incidents", name: "Agente de inteligencia de incidentes", role: "Análisis y relaciones de incidentes", specialty: "Incidentes", desc: "Ayudará a relacionar incidentes similares cuando haya registros disponibles." },
];

export function AgentCommand({ result, loading, onRun, onOpenMachine, machines, task, error, selectedMachineId, onSelectMachine, onRefreshTask }: {
  result: RecommendationResult | null; loading: boolean; onRun: () => void; onOpenMachine: (id: string) => void;
  machines: Machine[]; task: AgentTask | null; error: string; selectedMachineId: string; onSelectMachine: (id: string) => void; onRefreshTask: () => void;
}) {
  const [selected, setSelected] = useState<AgentRole>("coordinator");
  const agent = agents.find((item) => item.id === selected)!;
  return <div className="agent-command-page">
    <div className="agent-layout">
      <section className="panel agent-list-panel">
        <div className="section-heading"><div><div className="eyebrow">ROLES DEL ECOSISTEMA</div><h2>Especialidades planificadas</h2></div><span className="roster-count">6 ROLES · PLANIFICADOS</span></div>
        <div className="agent-roster">{agents.map((item) => <button className={`agent-row${selected === item.id ? " active" : ""}`} key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}>
          <span className="agent-avatar"><MascotMark role={item.id}/></span><span className="agent-identity"><b>{item.name}</b><small>{item.role}</small></span><AgentStatusBadge planned/>
        </button>)}</div>
      </section>
      <section className="panel agent-detail">
        <div className="eyebrow">PERFIL DE ESPECIALIDAD · {agent.specialty.toUpperCase()}</div>
        <div className="agent-profile-heading"><span className="agent-avatar large"><MascotMark role={agent.id}/></span><div><h2>{agent.name}</h2><p>{agent.role}</p></div><AgentStatusBadge planned/></div>
        <p className="agent-description">{agent.desc}</p>
        <div className="planned-detail"><Clock3 size={20}/><b>Capacidad planificada</b><span>Esta capacidad está en preparación. Aquí aparecerán sus resultados cuando esté disponible.</span></div>
      </section>
    </div>
    <IntelligenceWorkbench machines={machines} selectedMachineId={selectedMachineId} onSelectMachine={onSelectMachine} task={task} busy={loading} error={error} onRun={onRun} onRefresh={onRefreshTask}/>
    <WorkflowPanel result={result} loading={loading} onRun={onRun} onOpenAgents={() => setSelected("coordinator")}/>
  </div>;
}
