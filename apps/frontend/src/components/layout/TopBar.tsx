import { useRef } from "react";
import { Activity, ClipboardList, LayoutDashboard, Menu, PackageSearch, RefreshCw, Truck, UserRound, Wrench } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";
import type { AppView } from "../navigation/NavigationRail";

const live: [AppView, string][] = [["command", "Centro de mando"], ["fleet", "Flota"], ["agents", "Centro de agentes"], ["activity", "Actividad del sistema"], ["ingestion", "Ingesta de datos"]];
const planned: [AppView, string][] = [["maintenance", "Mantenimiento"], ["inventory", "Inventario"], ["technicians", "Técnicos"], ["incidents", "Incidentes"], ["orchestration", "Orquestación"]];
const technician: [AppView, string, typeof LayoutDashboard][] = [["myPanel", "Mi panel", LayoutDashboard], ["myAssignments", "Mis asignaciones", ClipboardList], ["myMachines", "Máquinas", Truck], ["myMaintenance", "Mantenimientos", Wrench], ["myParts", "Repuestos", PackageSearch], ["myHistory", "Historial", Activity]];
const moduleLabels: Record<AppView, string> = { command: "Centro de mando", fleet: "Flota", agents: "Centro de agentes", activity: "Actividad del sistema", ingestion: "Ingesta de datos", maintenance: "Mantenimiento", inventory: "Inventario", technicians: "Técnicos", incidents: "Incidentes", orchestration: "Orquestación AURA", myPanel: "Mi panel", myAssignments: "Mis asignaciones", myMachines: "Máquinas", myMaintenance: "Mis mantenimientos", myParts: "Repuestos", myHistory: "Historial personal" };

export function TopBar({ view, onNavigate, dateTime, onRefresh, refreshing, mobileMenu, onMenu, organization, role, onSignOut }: {
  view: AppView; onNavigate: (view: AppView) => void; dateTime: Date; onRefresh: () => void; refreshing: boolean; mobileMenu: boolean; onMenu: () => void; organization: string; role: string; onSignOut?: () => void;
}) {
  const headerRef = useRef<HTMLElement>(null);

  return <>
  <header ref={headerRef} className="dashboard-header">
    <div className="header-main"><button className="header-menu-toggle icon-button" onClick={onMenu} aria-expanded={mobileMenu} aria-controls="app-sidebar" aria-label="Contraer o expandir navegación"><Menu size={20}/></button><a href="/app" className="header-brand" aria-label="ArquiFusion, centro de mando"><BrandLockup/></a><div className="header-module"><span>ESPACIO ACTIVO</span><strong>{moduleLabels[view]}</strong></div>
      <div className="header-tools">
        <div className="header-clock"><time dateTime={dateTime.toISOString()}>{dateTime.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time><span>{dateTime.toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" })}</span></div>
        <button className={"icon-button refresh-button" + (refreshing ? " rotating" : "")} onClick={onRefresh} aria-label="Actualizar datos" title="Actualizar datos"><RefreshCw size={18}/></button>
        <details className="header-dropdown profile-menu"><summary aria-label="Abrir perfil"><UserRound size={18}/><span>Mi espacio</span></summary><div className="dropdown-panel"><strong>{organization}</strong><small>Organización seleccionada</small>{onSignOut && <button onClick={() => void onSignOut()}>Cerrar sesión</button>}</div></details>
      </div>
    </div>
    <nav id="dashboard-navigation" className={`dashboard-nav${mobileMenu ? " is-open" : ""}`} aria-label={role === "technician" ? "Navegación técnica" : "Navegación principal"}>
      {role === "technician" ? technician.map(([id, label, Icon]) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onNavigate(id)}><Icon size={14}/>{label}</button>) : <>{live.map(([id, label]) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onNavigate(id)}>{label}</button>)}
      <details className="header-dropdown planned-menu"><summary>Módulos operativos <span aria-hidden="true">⌄</span></summary><div className="dropdown-panel">{planned.map(([id, label]) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onNavigate(id); }}>{label}</button>)}</div></details></>}
    </nav>
  </header></>;
}