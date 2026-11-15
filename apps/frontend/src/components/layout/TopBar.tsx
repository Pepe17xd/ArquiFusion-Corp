import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, RefreshCw, UserRound } from "lucide-react";
import { BrandLockup } from "../brand/BrandMark";
import type { AppView } from "../navigation/NavigationRail";
import { headerScrollDecision } from "./header-scroll";

const live: [AppView, string][] = [["command", "Centro de mando"], ["fleet", "Flota"], ["agents", "Centro de agentes"], ["activity", "Actividad del sistema"], ["ingestion", "Ingesta de datos"]];
const planned: [AppView, string][] = [["maintenance", "Mantenimiento"], ["inventory", "Inventario"], ["technicians", "Técnicos"], ["incidents", "Incidentes"], ["orchestration", "Orquestación"]];

export function TopBar({ view, onNavigate, connected, checking, dateTime, onRefresh, refreshing, mobileMenu, onMenu, organization, onSignOut }: {
  view: AppView; onNavigate: (view: AppView) => void; connected: boolean; checking: boolean; dateTime: Date; onRefresh: () => void; refreshing: boolean; mobileMenu: boolean; onMenu: () => void; organization: string; onSignOut?: () => void;
}) {
  const headerRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const anchor = useRef(0);
  const [hidden, setHidden] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [openDetails, setOpenDetails] = useState(false);
  const locked = mobileMenu || focusWithin || openDetails;

  useLayoutEffect(() => {
    if (headerRef.current) headerRef.current.inert = hidden;
  }, [hidden]);

  useEffect(() => {
    if (!hidden && restoreFocus.current) {
      restoreFocus.current = false;
      headerRef.current?.querySelector<HTMLElement>(".header-brand")?.focus();
    }
  }, [hidden]);

  useEffect(() => {
    anchor.current = window.scrollY;
    if (locked) setHidden(false);
    const onScroll = () => {
      const decision = headerScrollDecision(anchor.current, window.scrollY, locked);
      anchor.current = decision.anchor;
      if (decision.hidden !== null) setHidden(decision.hidden);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [locked]);

  function updateDetails() {
    setOpenDetails(Boolean(headerRef.current?.querySelector("details[open]")));
  }

  return <>
  {hidden && <button className="header-reveal" onClick={() => { restoreFocus.current = true; setHidden(false); anchor.current = window.scrollY; }}>Mostrar navegación</button>}
  <header ref={headerRef} className={`dashboard-header${hidden ? " is-hidden" : ""}`} onFocus={() => setFocusWithin(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false); }}>
    <div className="header-main"><a href="/app" className="header-brand" aria-label="ArquiFusion, centro de mando"><BrandLockup/></a>
      <div className="header-tools"><div className="service-state" role="status"><i className={`origin-led ${checking ? "checking" : connected ? "online" : "offline"}`}/>{checking ? "Comprobando comunicación" : connected ? "Servicios en comunicación" : "Servicio de salud no disponible"}</div>
        <div className="header-clock"><time dateTime={dateTime.toISOString()}>{dateTime.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time><span>{dateTime.toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" })}</span></div>
        <button className={"icon-button refresh-button" + (refreshing ? " rotating" : "")} onClick={onRefresh} aria-label="Actualizar datos" title="Actualizar datos"><RefreshCw size={18}/></button>
        <details className="header-dropdown profile-menu" onToggle={updateDetails}><summary aria-label="Abrir perfil"><UserRound size={18}/><span>Mi espacio</span></summary><div className="dropdown-panel"><strong>{organization}</strong><small>Organización seleccionada</small>{onSignOut && <button onClick={() => void onSignOut()}>Cerrar sesión</button>}</div></details>
        <button className="header-menu-toggle icon-button" onClick={onMenu} aria-expanded={mobileMenu} aria-controls="dashboard-navigation" aria-label={mobileMenu ? "Cerrar navegación" : "Abrir navegación"}><Menu size={21}/></button>
      </div>
    </div>
    <nav id="dashboard-navigation" className={`dashboard-nav${mobileMenu ? " is-open" : ""}`} aria-label="Navegación principal">
      {live.map(([id, label]) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onNavigate(id)}>{label}</button>)}
      <details className="header-dropdown planned-menu" onToggle={updateDetails}><summary>Módulos planificados <span aria-hidden="true">⌄</span></summary><div className="dropdown-panel">{planned.map(([id, label]) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onNavigate(id); }}>{label}<small>Planificado</small></button>)}</div></details>
    </nav>
  </header></>;
}
