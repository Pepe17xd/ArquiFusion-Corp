import { ChevronRight, Clock3, Menu, RefreshCw } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";
import { ConnectionBadge } from "../ui/StatusBadge";
import type { AppView } from "../navigation/NavigationRail";

const titles: Record<AppView, string> = {
  command: "Centro de mando", fleet: "Equipos de flota", agents: "Centro de agentes",
  activity: "Actividad del sistema", ingestion: "Ingesta de datos", maintenance: "Mantenimiento predictivo",
  inventory: "Inteligencia de inventario", technicians: "Asignación de técnicos", incidents: "Centro de incidentes",
};

export function TopBar({ view, connected, checking, dateTime, onRefresh, refreshing, onMenu }: {
  view: AppView; connected: boolean; checking: boolean; dateTime: Date; onRefresh: () => void; refreshing: boolean; onMenu: () => void;
}) {
  return (
    <header className="top-bar">
      <button className="mobile-menu icon-button" onClick={onMenu} aria-label="Abrir navegación"><Menu size={18}/></button>
      <div className="mobile-lockup"><BrandLockup compact/></div>
      <div className="breadcrumb"><span>ARQUIFUSION</span><ChevronRight size={13}/><b>{titles[view]}</b></div>
      <div className="top-bar-right">
        <div className="clock-readout"><Clock3 size={14}/><time>{dateTime.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time><span>{dateTime.toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" })}</span></div>
        <ConnectionBadge connected={connected} checking={checking}/>
        <button className={"icon-button refresh-button" + (refreshing ? " rotating" : "")} onClick={onRefresh} aria-label="Actualizar datos" title="Actualizar datos"><RefreshCw size={15}/></button>
        <span className="topbar-divider"/>
        <span className="secure-indicator" title="Interfaz local del workspace"><span/>LOCAL</span>
      </div>
    </header>
  );
}
