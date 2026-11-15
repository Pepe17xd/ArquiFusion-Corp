import { Activity, Bot, ClipboardList, Command, Cpu, Gauge, HardHat, LayoutDashboard, PackageSearch, Truck, UploadCloud, Workflow, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";
import { ConnectionBadge } from "../ui/StatusBadge";

export type AppView = "command" | "fleet" | "agents" | "activity" | "ingestion" | "maintenance" | "inventory" | "technicians" | "incidents" | "orchestration" | "myPanel" | "myAssignments" | "myMachines" | "myMaintenance" | "myParts" | "myHistory";
interface NavItem { id: AppView; label: string; icon: LucideIcon; planned?: boolean }
const liveItems: NavItem[] = [
  { id: "command", label: "Centro de mando", icon: LayoutDashboard },
  { id: "fleet", label: "Flota", icon: Truck },
  { id: "agents", label: "Centro de agentes", icon: Bot },
  { id: "activity", label: "Actividad del sistema", icon: Activity },
  { id: "ingestion", label: "Ingesta de datos", icon: UploadCloud },
];
const plannedItems: NavItem[] = [
  { id: "maintenance", label: "Mantenimiento", icon: Wrench, planned: true },
  { id: "inventory", label: "Inventario", icon: PackageSearch, planned: true },
  { id: "technicians", label: "Técnicos", icon: HardHat, planned: true },
  { id: "incidents", label: "Incidentes", icon: ClipboardList, planned: true },
  { id: "orchestration", label: "Orquestación", icon: Workflow, planned: true },
];
const technicianItems: NavItem[] = [
  { id: "myPanel", label: "Mi panel", icon: LayoutDashboard },
  { id: "myAssignments", label: "Mis asignaciones", icon: ClipboardList },
  { id: "myMachines", label: "Máquinas asignadas", icon: Truck },
  { id: "myMaintenance", label: "Mis mantenimientos", icon: Wrench },
  { id: "myParts", label: "Repuestos solicitados", icon: PackageSearch },
  { id: "myHistory", label: "Historial personal", icon: Activity },
];

export function NavigationRail({ view, onNavigate, connected, checking, fleetCount, role }: {
  view: AppView; onNavigate: (view: AppView) => void; connected: boolean; checking: boolean; fleetCount: number; role: string;
}) {
  const renderItems = (items: NavItem[]) => items.map(({ id, label, icon: Icon, planned }) => (
    <button key={id} className={"nav-link" + (view === id ? " selected" : "") + (planned ? " nav-planned" : "")} onClick={() => onNavigate(id)} title={label} aria-current={view === id ? "page" : undefined}>
      <Icon size={17}/><span>{label}</span>
      {id === "fleet" && <small className="nav-count">{fleetCount}</small>}
      {planned && <small className="nav-soon">PLAN</small>}
    </button>
  ));

  return (
    <aside className="navigation-rail">
      <BrandLockup />
      <div className="workspace-switch"><span className="workspace-mark"><Command size={13}/></span><span><small>ESPACIO DE TRABAJO</small><b>Operaciones</b></span><span className="workspace-caret">⌄</span></div>
      {role === "technician" ? <><div className="nav-group-label">ESPACIO TÉCNICO</div><nav className="primary-nav" aria-label="Navegación técnica">{renderItems(technicianItems)}</nav></> : <><div className="nav-group-label">OPERACIONES</div><nav className="primary-nav" aria-label="Navegación principal">{renderItems(liveItems)}</nav><div className="nav-group-label secondary-label">MÓDULOS OPERATIVOS</div><nav className="primary-nav planned-nav" aria-label="Módulos operativos">{renderItems(plannedItems)}</nav></>}
      <div className="rail-bottom">
        <div className="rail-system"><span className="system-glyph"><Cpu size={15}/></span><div><small>SISTEMA CENTRAL</small><b>Capa operativa</b></div><span className={"rail-led " + (connected ? "online" : checking ? "checking" : "offline")}/></div>
        <ConnectionBadge connected={connected} checking={checking}/>
        <div className="rail-foot"><Gauge size={13}/> ARQUIFUSION <span>2.0</span></div>
      </div>
    </aside>
  );
}
