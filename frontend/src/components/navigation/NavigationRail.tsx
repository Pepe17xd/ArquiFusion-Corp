import { Activity, Bot, Boxes, ClipboardList, Command, Cpu, Gauge, HardHat, LayoutDashboard, PackageSearch, Truck, UploadCloud, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";
import { ConnectionBadge } from "../ui/StatusBadge";

export type AppView = "command" | "fleet" | "agents" | "activity" | "ingestion" | "maintenance" | "inventory" | "technicians" | "incidents";
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
];

export function NavigationRail({ view, onNavigate, connected, checking, fleetCount }: {
  view: AppView; onNavigate: (view: AppView) => void; connected: boolean; checking: boolean; fleetCount: number;
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
      <div className="nav-group-label">OPERACIONES</div>
      <nav className="primary-nav" aria-label="Navegación principal">{renderItems(liveItems)}</nav>
      <div className="nav-group-label secondary-label">MÓDULOS PLANIFICADOS</div>
      <nav className="primary-nav planned-nav" aria-label="Módulos planificados">{renderItems(plannedItems)}</nav>
      <div className="rail-bottom">
        <div className="rail-system"><span className="system-glyph"><Cpu size={15}/></span><div><small>SISTEMA CENTRAL</small><b>Capa operativa</b></div><span className={"rail-led " + (connected ? "online" : checking ? "checking" : "offline")}/></div>
        <ConnectionBadge connected={connected} checking={checking}/>
        <div className="rail-foot"><Gauge size={13}/> ARQUIFUSION <span>2.0</span></div>
      </div>
    </aside>
  );
}
