import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { fleetApi, type FleetMetrics, type Machine, type RecommendationResult } from "./services/api/client";
import { NavigationRail, type AppView } from "./components/navigation/NavigationRail";
import { TopBar } from "./components/layout/TopBar";
import { FeedbackBanner } from "./components/feedback/FeedbackBanner";
import { CommandCenter } from "./features/dashboard/CommandCenter";
import { FleetView, MachineDialog } from "./features/fleet/FleetView";
import { AgentCommand } from "./features/intelligence/AgentCommand";
import { ActivityView } from "./features/operations/ActivityView";
import { IngestionView } from "./features/ingestion/IngestionView";
import { PlannedView } from "./features/planned/PlannedView";
import "./style.css";

const headings: Record<AppView, [string, string]> = {
  command: ["Centro de mando", "Estado de la flota, señales actuales e inteligencia operacional en una sola vista."],
  fleet: ["Flota", "Busca e inspecciona la maquinaria registrada."],
  agents: ["Centro de agentes", "Workflow operativo y roles planificados para la plataforma."],
  activity: ["Actividad del sistema", "Estado de la trazabilidad operacional."],
  ingestion: ["Ingesta de datos", "Normaliza registros de flota desde archivos de origen."],
  maintenance: ["Mantenimiento predictivo", "Módulo planificado · aún no hay registros ni programas de mantenimiento."],
  inventory: ["Inteligencia de inventario", "Módulo planificado · aún no hay datos de repuestos."],
  technicians: ["Asignación de técnicos", "Módulo planificado · aún no hay registros de técnicos."],
  incidents: ["Centro de incidentes", "Módulo planificado · la gestión de incidentes aún no está disponible."],
};

export default function App() {
  const [view, setView] = useState<AppView>("command");
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recommendationResult, setRecommendationResult] = useState<RecommendationResult | null>(null);
  const [intelligenceError, setIntelligenceError] = useState("");
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [importing, setImporting] = useState(false);
  const [now, setNow] = useState(new Date());
  const [mobileMenu, setMobileMenu] = useState(false);

  const cursor = cursorStack.at(-1);
  const load = useCallback(async (reset = false) => {
    setLoading(true);
    setChecking(true);
    setError("");
    const params = new URLSearchParams({ limit: "20" });
    if (!reset && cursor) params.set("cursor", cursor);
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    if (search) params.set("search", search);
    const [health, page, totals] = await Promise.allSettled([fleetApi.health(), fleetApi.machines(params), fleetApi.metrics()]);

    if (health.status === "fulfilled") setConnected(health.value.status === "ok");
    else setConnected(false);
    setChecking(false);
    if (page.status === "fulfilled") { setMachines(page.value.items); setNextCursor(page.value.nextCursor); }
    else { setMachines([]); setNextCursor(undefined); }
    if (totals.status === "fulfilled") setMetrics(totals.value);
    else setMetrics(null);

    const failure = page.status === "rejected" ? page.reason : totals.status === "rejected" ? totals.reason : health.status === "rejected" ? health.reason : undefined;
    if (failure) setError(failure instanceof Error ? failure.message : "No se pudieron cargar los datos de la API.");
    setLoading(false);
  }, [cursor, status, category, search]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);

  const runIntelligence = useCallback(async () => {
    setIntelligenceLoading(true); setError(""); setIntelligenceError(""); setRecommendationResult(null);
    try { setRecommendationResult(await fleetApi.recommendations()); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "No se pudo ejecutar Intelligence."; setIntelligenceError(message); setError(message); }
    finally { setIntelligenceLoading(false); }
  }, []);
  useEffect(() => { void runIntelligence(); }, [runIntelligence]);

  async function openMachine(id: string) {
    try { setSelectedMachine(await fleetApi.machine(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo consultar la máquina."); }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault(); setCursorStack([]); setSearch(searchInput.trim());
  }

  async function ingest(file?: File) {
    if (!file) return;
    if (!/\.(csv|json)$/i.test(file.name)) { setError("Selecciona un archivo CSV o JSON."); return; }
    setImporting(true); setError(""); setNotice("");
    try {
      const result = await fleetApi.ingest(file);
      setNotice(`${result.processed} registros procesados: ${result.accepted.length} aceptados y ${result.rejected.length} rechazados. Original: ${result.originalFileUri}`);
      setCursorStack([]); await load(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falló la importación."); }
    finally { setImporting(false); }
  }

  function navigate(target: AppView) {
    if (target === "command") { setCursorStack([]); setSearch(""); setSearchInput(""); setStatus(""); setCategory(""); }
    setView(target); setMobileMenu(false);
  }

  return <div className="app-frame">
    {mobileMenu && <button className="rail-scrim" aria-label="Cerrar navegación" onClick={() => setMobileMenu(false)}/>}
    <div className={`rail-wrap${mobileMenu ? " mobile-open" : ""}`}><NavigationRail view={view} onNavigate={navigate} connected={connected} checking={checking} fleetCount={metrics?.total ?? 0}/></div>
    <div className="main-column">
      <TopBar view={view} connected={connected} checking={checking} dateTime={now} onRefresh={() => void load()} refreshing={loading} onMenu={() => setMobileMenu((open) => !open)}/>
      <main className="content-area">
        {(error || notice) && <FeedbackBanner kind={error ? "error" : "success"} onDismiss={() => { setError(""); setNotice(""); }}>{error || notice}</FeedbackBanner>}
        <div className="page-intro"><div><div className="eyebrow">ARQUIFUSION / OPERACIONES</div><h1>{headings[view][0]}</h1><p>{headings[view][1]}</p></div>{view !== "ingestion" && <span className="data-origin"><span className={`origin-led ${connected ? "online" : checking ? "checking" : "offline"}`}/>{connected ? "DATOS DE API" : checking ? "REVISANDO API" : "API SIN CONEXIÓN"}</span>}</div>
        {view === "command" && <CommandCenter metrics={metrics} machines={machines} total={metrics?.total ?? 0} loading={loading} result={recommendationResult} intelligenceLoading={intelligenceLoading} intelligenceError={intelligenceError} onRun={runIntelligence} onNavigate={navigate} onOpenMachine={openMachine}/>}
        {view === "fleet" && <FleetView machines={machines} metrics={metrics} loading={loading} search={searchInput} setSearch={setSearchInput} onSearch={submitSearch} status={status} setStatus={(value) => { setCursorStack([]); setStatus(value); }} category={category} setCategory={(value) => { setCursorStack([]); setCategory(value); }} cursorStack={cursorStack} nextCursor={nextCursor} setCursorStack={setCursorStack} onOpenMachine={openMachine}/>} 
        {view === "agents" && <AgentCommand result={recommendationResult} loading={intelligenceLoading} onRun={runIntelligence} onOpenMachine={openMachine}/>} 
        {view === "activity" && <ActivityView/>}
        {view === "ingestion" && <IngestionView importing={importing} onFile={ingest}/>}
        {["maintenance", "inventory", "technicians", "incidents"].includes(view) && <PlannedView view={view} description={headings[view][1]}/>}
        <footer className="page-footer"><span>ARQUIFUSION <i/> INTELIGENCIA OPERACIONAL</span><span>DESARROLLO LOCAL · <b>{connected ? "API CONECTADA" : checking ? "CONECTANDO" : "API SIN CONEXIÓN"}</b></span></footer>
      </main>
    </div>
    {selectedMachine && <MachineDialog machine={selectedMachine} onClose={() => setSelectedMachine(null)}/>}
  </div>;
}
