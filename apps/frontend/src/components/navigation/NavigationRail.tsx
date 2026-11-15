import { Activity, Bot, ClipboardList, Command, Cpu, Gauge, HardHat, LayoutDashboard, PackageSearch, Truck, UploadCloud, Workflow, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";

export type AppView = "command" | "fleet" | "agents" | "activity" | "ingestion" | "maintenance" | "inventory" | "technicians" | "incidents" | "orchestration" | "myPanel" | "myAssignments" | "myMachines" | "myMaintenance" | "myParts" | "myHistory";
interface NavItem { id: AppView; label: string; icon: LucideIcon }
const liveItems: NavItem[] = [
  { id: "command", label: "Centro de mando", icon: LayoutDashboard },
  { id: "fleet", label: "Flota", icon: Truck },
  { id: "agents", label: "Centro de agentes", icon: Bot },
  { id: "activity", label: "Actividad del sistema", icon: Activity },
  { id: "ingestion", label: "Ingesta de datos", icon: UploadCloud },
];
const operationalItems: NavItem[] = [
  { id: "incidents", label: "Incidentes", icon: ClipboardList },
  { id: "maintenance", label: "Mantenimiento", icon: Wrench },
  { id: "technicians", label: "Técnicos", icon: HardHat },
  { id: "inventory", label: "Inventario", icon: PackageSearch },
  { id: "orchestration", label: "Orquestación AURA", icon: Workflow },
];
const technicianItems: NavItem[] = [
  { id: "myPanel", label: "Mi panel", icon: LayoutDashboard },
  { id: "myAssignments", label: "Mis asignaciones", icon: ClipboardList },
  { id: "myMachines", label: "Máquinas asignadas", icon: Truck },
  { id: "myMaintenance", label: "Mis mantenimientos", icon: Wrench },
  { id: "myParts", label: "Repuestos solicitados", icon: PackageSearch },
  { id: "myHistory", label: "Historial personal", icon: Activity },
];

export function NavigationRail({ view, onNavigate, fleetCount, role, collapsed, mobileOpen }: {
  view: AppView; onNavigate: (view: AppView) => void; fleetCount?: number; role: string; collapsed: boolean; mobileOpen: boolean;
}) {
  const renderItems = (items: NavItem[]) => items.map(({ id, label, icon: Icon }) => (
    <button key={id} className={"nav-link" + (view === id ? " selected" : "")} onClick={() => onNavigate(id)} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} aria-current={view === id ? "page" : undefined}>
      <Icon size={17}/><span>{label}</span>
      {id === "fleet" && fleetCount !== undefined && <small className="nav-count">{fleetCount}</small>}
    </button>
  ));

  return (
    <aside id="app-sidebar" className={`navigation-rail${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-mobile-open" : ""}`} aria-label="Navegación de ArquiFusion">
      <BrandLockup />
      <div className="workspace-switch"><span className="workspace-mark"><Command size={13}/></span><span><small>ESPACIO DE TRABAJO</small><b>Operaciones</b></span><span className="workspace-caret">⌄</span></div>
      {role === "technician" ? <><div className="nav-group-label">ESPACIO TÉCNICO</div><nav className="primary-nav" aria-label="Navegación técnica">{renderItems(technicianItems)}</nav></> : <><div className="nav-group-label">PLATAFORMA</div><nav className="primary-nav" aria-label="Navegación principal">{renderItems(liveItems)}</nav><div className="nav-group-label secondary-label">OPERACIONES</div><nav className="primary-nav" aria-label="Módulos operativos">{renderItems(operationalItems)}</nav></>}
      <div className="rail-bottom">
        <div className="rail-system"><span className="system-glyph"><Cpu size={15}/></span><div><small>SISTEMA CENTRAL</small><b>Capa operativa</b></div></div>
        <div className="rail-foot"><Gauge size={13}/> ARQUIFUSION <span>2.0</span></div>
      </div>
    </aside>
  );
}
