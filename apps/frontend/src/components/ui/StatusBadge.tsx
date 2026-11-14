import { Check, CircleDashed, Clock3, TriangleAlert, Wrench } from "lucide-react";
import type { MachineStatus } from "../../services/api/client";

const machineLabels: Record<MachineStatus, string> = {
  operational: "Operativa", maintenance: "Mantenimiento", stopped: "Detenida", alert: "Alerta",
};
const machineIcons = { operational: Check, maintenance: Wrench, stopped: CircleDashed, alert: TriangleAlert };

export function MachineStatusBadge({ status }: { status: MachineStatus }) {
  const Icon = machineIcons[status];
  return <span className={"status-badge machine-status " + status}><Icon size={12}/>{machineLabels[status]}</span>;
}

export function AgentStatusBadge({ planned = false }: { planned?: boolean }) {
  return planned
    ? <span className="status-badge planned"><Clock3 size={12}/>Planificado</span>
    : <span className="status-badge active"><span className="status-dot"/>Operativo</span>;
}

export function ConnectionBadge({ connected, checking }: { connected: boolean; checking: boolean }) {
  const label = checking ? "Comprobando API" : connected ? "API conectada" : "API sin conexión";
  return <span className={"connection-badge " + (connected ? "online" : checking ? "checking" : "offline")}><span className="status-dot"/>{label}</span>;
}
