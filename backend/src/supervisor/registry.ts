import type { AgentDescriptor, AgentId, TaskType } from "./contracts";

const catalog: AgentDescriptor[] = [
  { id: "fleet-intelligence", name: "Inteligencia determinista de flota", specialty: "Mantenimiento y señales operacionales", capabilities: ["fleet.recommendations"], inputs: ["registered-machines"], outputs: ["evidence-backed-recommendations"], status: "operational", version: "1.0.0" },
  { id: "coordinator", name: "Agente coordinador", specialty: "Coordinación", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
  { id: "maintenance", name: "Agente de mantenimiento predictivo", specialty: "Mantenimiento", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
  { id: "fleet-operations", name: "Agente de operaciones de flota", specialty: "Operaciones", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
  { id: "inventory", name: "Agente de inteligencia de inventario", specialty: "Inventario", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
  { id: "technician-assignment", name: "Agente de asignación de técnicos", specialty: "Técnicos", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
  { id: "incident-intelligence", name: "Agente de inteligencia de incidentes", specialty: "Incidentes", capabilities: [], inputs: [], outputs: [], status: "planned", version: "0.0.0" },
];

export function listAgents(): AgentDescriptor[] { return catalog.map((agent) => ({ ...agent, capabilities: [...agent.capabilities], inputs: [...agent.inputs], outputs: [...agent.outputs] })); }
export function resolveAgent(taskType: TaskType): AgentDescriptor {
  const agent = catalog.find((item) => item.status === "operational" && item.capabilities.includes(taskType));
  if (!agent) throw new Error(`No hay un agente operativo autorizado para ${taskType}`);
  return agent;
}
export function isAgentId(value: string): value is AgentId { return catalog.some((agent) => agent.id === value); }
