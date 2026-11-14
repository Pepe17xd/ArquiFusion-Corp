import { useState } from "react";
import { LoaderCircle, Play, ShieldCheck } from "lucide-react";
import { ArtificialBrain, MascotMark, type AgentRole } from "./MascotMark";

const roles: { id: AgentRole; name: string; summary: string; specialty: string }[] = [
  { id: "coordinator", name: "Coordinación", summary: "Organiza el trabajo entre las capacidades del ecosistema.", specialty: "Orquestación" },
  { id: "maintenance", name: "Mantenimiento predictivo", summary: "Detectará patrones de desgaste y posibles fallos.", specialty: "Mantenimiento" },
  { id: "fleet", name: "Operaciones de flota", summary: "Analizará actividad, utilización y productividad.", specialty: "Operaciones" },
  { id: "inventory", name: "Inteligencia de inventario", summary: "Relacionará existencias con necesidades de repuestos.", specialty: "Repuestos" },
  { id: "technicians", name: "Asignación de técnicos", summary: "Coordinará especialistas, capacidades y carga de trabajo.", specialty: "Personal" },
  { id: "incidents", name: "Inteligencia de incidentes", summary: "Analizará sucesos y sus relaciones operativas.", specialty: "Incidentes" },
];

export function BrainEcosystem({ loading, completed, error, onRun }: { loading: boolean; completed: boolean; error?: string; onRun: () => void }) {
  const [selected, setSelected] = useState<AgentRole>("coordinator");
  const active = roles.find((role) => role.id === selected)!;
  const state = error ? "error" : loading ? "processing" : completed ? "complete" : "idle";
  return <section className={`ecosystem-panel${loading ? " is-processing" : ""}`} aria-labelledby="ecosystem-title">
    <div className="ecosystem-heading"><div><div className="eyebrow">ECOSISTEMA DE INTELIGENCIA</div><h2 id="ecosystem-title">Un núcleo. Seis especialidades.</h2><p>El workflow operativo evalúa datos reales de la flota; los demás roles son capacidades planificadas.</p></div><span className="ecosystem-key"><i/>Arquitectura objetivo</span></div>
    <div className="ecosystem-stage">
      <svg className="ecosystem-links" viewBox="0 0 1000 540" preserveAspectRatio="none" aria-hidden="true">
        <path d="M184 82C292 82 330 180 410 204M816 82C708 82 670 180 590 204M145 270H376M855 270H624M184 458C292 458 330 360 410 336M816 458C708 458 670 360 590 336"/>
        <circle cx="184" cy="82" r="4"/><circle cx="816" cy="82" r="4"/><circle cx="145" cy="270" r="4"/><circle cx="855" cy="270" r="4"/><circle cx="184" cy="458" r="4"/><circle cx="816" cy="458" r="4"/>
      </svg>
      {roles.map((role) => <button key={role.id} className={`ecosystem-role role-${role.id}${selected === role.id ? " selected" : ""}`} onClick={() => setSelected(role.id)} aria-pressed={selected === role.id}>
        <MascotMark role={role.id}/><span className="role-copy"><b>{role.name}</b><small><i/>Planificado</small></span><span className="role-specialty">{role.specialty}</span>
      </button>)}
      <div className={`brain-core state-${state}`}>
        <div className="brain-core-top"><span><i className={`origin-led ${loading ? "checking" : error ? "offline" : completed ? "online" : ""}`}/>{error ? "Error del workflow" : loading ? "Evaluación en curso" : completed ? "Evaluación completada" : "Núcleo inteligente"}</span><span className="core-version">LANGGRAPH</span></div>
        <ArtificialBrain state={state}/>
        <div className="brain-core-bottom"><div><b>Evaluación determinista de flota</b><small>Única capacidad de inteligencia operativa</small></div><button className="brain-run-button" onClick={onRun} disabled={loading} aria-label="Ejecutar evaluación de flota">{loading ? <LoaderCircle size={16}/> : <Play size={15}/>}<span>{loading ? "Evaluando" : "Ejecutar"}</span></button></div>
      </div>
    </div>
    <div className="ecosystem-detail" aria-live="polite"><MascotMark role={active.id}/><div><span className="eyebrow">ESPECIALIDAD · {active.specialty}</span><b>{active.name}</b><p>{active.summary}</p></div><span className="planned-pill">PLANIFICADO</span></div>
    <div className="ecosystem-note"><ShieldCheck size={14}/><span>Las conexiones representan la arquitectura objetivo; no indican ejecuciones. Solo el workflow determinista central está implementado.</span></div>
  </section>;
}
