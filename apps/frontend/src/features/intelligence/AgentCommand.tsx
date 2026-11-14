import { useState } from "react";
import { Clock3 } from "lucide-react";
import { AgentStatusBadge } from "../../components/ui/StatusBadge";
import { MascotMark, type AgentRole } from "../../components/agents/MascotMark";
import { WorkflowPanel } from "../../components/agents/WorkflowPanel";
import type { Machine, RecommendationResult } from "../../services/api/client";

const agents: { id: AgentRole; name: string; role: string; desc: string; specialty: string }[] = [
  { id: "coordinator", name: "Agente coordinador", role: "Organización del ecosistema", specialty: "Coordinación", desc: "Coordinará el trabajo entre especialidades. No existe todavía una implementación de este agente en el backend." },
  { id: "maintenance", name: "Agente de mantenimiento predictivo", role: "Patrones de desgaste y fallos", specialty: "Mantenimiento", desc: "Identificará patrones de desgaste y posibles fallos. La evaluación actual de flota es un workflow determinista y no un agente autónomo." },
  { id: "fleet", name: "Agente de operaciones de flota", role: "Actividad y productividad", specialty: "Operaciones", desc: "Analizará actividad, utilización y productividad cuando existan contratos y datos para esas capacidades." },
  { id: "inventory", name: "Agente de inteligencia de inventario", role: "Repuestos y existencias", specialty: "Repuestos", desc: "Relacionará disponibilidad de repuestos con necesidades operativas. El inventario aún no está implementado." },
  { id: "technicians", name: "Agente de asignación de técnicos", role: "Especialistas y carga de trabajo", specialty: "Personal", desc: "Coordinará capacidades y carga de trabajo. Aún no existen perfiles de técnicos ni un workflow de asignación." },
  { id: "incidents", name: "Agente de inteligencia de incidentes", role: "Análisis y relaciones de incidentes", specialty: "Incidentes", desc: "Analizará incidentes y sus relaciones una vez que el backend disponga de los registros correspondientes." },
];

export function AgentCommand({ result, loading, onRun, onOpenMachine }: {
  result: RecommendationResult | null; loading: boolean; onRun: () => void; onOpenMachine: (id: string) => void;
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
        <div className="planned-detail"><Clock3 size={20}/><b>Capacidad planificada</b><span>No dispone de endpoint, ejecución, entradas ni historial de resultados en el backend.</span></div>
      </section>
    </div>
    <WorkflowPanel result={result} loading={loading} onRun={onRun} onOpenAgents={() => setSelected("coordinator")}/>
  </div>;
}
