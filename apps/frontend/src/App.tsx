import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { fleetApi, apiSession, type AgentTask, type FleetMetrics, type Machine, type OperationsOverview, type RecommendationResult } from "./services/api/client";
import { type AppView } from "./components/navigation/NavigationRail";
import { TopBar } from "./components/layout/TopBar";
import { FeedbackBanner } from "./components/feedback/FeedbackBanner";
import { CommandCenter } from "./features/dashboard/CommandCenter";
import { FleetView, MachineDialog } from "./features/fleet/FleetView";
import { AgentCommand } from "./features/intelligence/AgentCommand";
import { ActivityView } from "./features/operations/ActivityView";
import { IngestionView } from "./features/ingestion/IngestionView";
import { PlannedView } from "./features/planned/PlannedView";
import { authMode, selectedTenantId, signOut } from "./services/auth/session";
import "./style.css";
import "./supervisor.css";
import "./dashboard-redesign.css";

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
  const [view, setView] = useState<AppView>(() => { const target = window.location.hash.slice(1); return ["fleet", "agents", "activity", "ingestion"].includes(target) ? target as AppView : "command"; });
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fleetError, setFleetError] = useState(false);
  const loadVersion = useRef(0);
  const [notice, setNotice] = useState("");
  const [recommendationResult, setRecommendationResult] = useState<RecommendationResult | null>(null);
  const [intelligenceError, setIntelligenceError] = useState("");
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [task, setTask] = useState<AgentTask | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [organization, setOrganization] = useState(authMode === "local" ? "Entorno local" : "Organización seleccionada");
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [importing, setImporting] = useState(false);
  const [now, setNow] = useState(new Date());
  const [mobileMenu, setMobileMenu] = useState(false);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setChecking(true);
    setError("");
    const allMachines = async () => {
      const items: Machine[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const page = await fleetApi.machines(params);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("La API devolvi? un cursor repetido; no se pudo completar la carga de flota.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return items;
    };
    const [health, page, totals, operations] = await Promise.allSettled([fleetApi.health(), allMachines(), fleetApi.metrics(), fleetApi.overview()]);

    if (version !== loadVersion.current) return;
    if (health.status === "fulfilled") setConnected(health.value.status === "ok");
    else setConnected(false);
    setChecking(false);
    setFleetError(page.status === "rejected");
    if (page.status === "fulfilled") setMachines(page.value);
    else setMachines([]);
    if (totals.status === "fulfilled") setMetrics(totals.value);
    else setMetrics(null);
    if (operations.status === "fulfilled") setOverview(operations.value);
    else setOverview(null);
    if (page.status === "fulfilled" || totals.status === "fulfilled") setLastUpdated(new Date());

    const failure = page.status === "rejected" ? page.reason : totals.status === "rejected" ? totals.reason : health.status === "rejected" ? health.reason : undefined;
    if (failure) setError(failure instanceof Error ? failure.message : "No se pudieron cargar los datos de la API.");
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (authMode === "cognito") void apiSession.tenants().then(items => { const found = items.find(item => item.tenant.tenantId === selectedTenantId()); if (found) setOrganization(found.tenant.name); }).catch(() => undefined); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);

  const runIntelligence = useCallback(async () => {
    setIntelligenceLoading(true); setError(""); setIntelligenceError(""); setRecommendationResult(null); setTask(null);
    try {
      const submitted = await fleetApi.submitRecommendationTask(`dashboard-${crypto.randomUUID()}`);
      let task = submitted.task;
      setTask(task);
      for (let poll = 0; poll < 80 && !["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state); poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        task = await fleetApi.task(task.taskId);
        setTask(task);
      }
      if (task.state !== "SUCCEEDED" || !task.result) throw new Error(task.error?.message || "La ejecución no terminó correctamente.");
      setRecommendationResult(task.result);
      void fleetApi.overview().then(setOverview).catch(() => undefined);
    }
    catch (reason) { const message = reason instanceof Error ? reason.message : "No se pudo ejecutar Intelligence."; setIntelligenceError(message); setError(message); }
    finally { setIntelligenceLoading(false); }
  }, []);
  useEffect(() => { void runIntelligence(); }, [runIntelligence]);

  async function openMachine(id: string) {
    try { setSelectedMachine(await fleetApi.machine(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo consultar la máquina."); }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault(); setPageNumber(1); setSearch(searchInput.trim());
  }

  async function ingest(file?: File) {
    if (!file) return;
    if (!/\.(csv|json)$/i.test(file.name)) { setError("Selecciona un archivo CSV o JSON."); return; }
    setImporting(true); setError(""); setNotice("");
    try {
      const result = await fleetApi.ingest(file);
      setNotice(`${result.processed} registros procesados: ${result.accepted.length} aceptados y ${result.rejected.length} rechazados. Original: ${result.originalFileUri}`);
      setPageNumber(1); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falló la importación."); }
    finally { setImporting(false); }
  }

  function navigate(target: AppView) {
    if (target === "command") { setPageNumber(1); setSearch(""); setSearchInput(""); setStatus(""); setCategory(""); }
    setView(target); setMobileMenu(false);
  }

  return <div className="app-frame">
    <div className="main-column">
      <TopBar view={view} onNavigate={navigate} connected={connected} checking={checking} dateTime={now} onRefresh={() => void load()} refreshing={loading} mobileMenu={mobileMenu} onMenu={() => setMobileMenu((open) => !open)} organization={organization} onSignOut={authMode === "cognito" ? signOut : undefined}/>
      <main className="content-area">
        {(error || notice) && <FeedbackBanner kind={error ? "error" : "success"} onDismiss={() => { setError(""); setNotice(""); }}>{error || notice}</FeedbackBanner>}
        <div className="page-intro"><div><div className="eyebrow">ARQUIFUSION / OPERACIONES</div><h1>{headings[view][0]}</h1><p>{headings[view][1]}</p></div>{view !== "ingestion" && <span className="data-origin"><span className={`origin-led ${connected ? "online" : checking ? "checking" : "offline"}`}/>{connected ? "DATOS DE API" : checking ? "REVISANDO API" : "API SIN CONEXIÓN"}</span>}</div>
        {view === "command" && <CommandCenter metrics={metrics} machines={machines} total={metrics?.total ?? 0} loading={loading} result={recommendationResult} intelligenceLoading={intelligenceLoading} intelligenceError={intelligenceError} overview={overview} task={task} connected={connected} checking={checking} lastUpdated={lastUpdated} organization={organization} onRun={runIntelligence} onNavigate={navigate} onOpenMachine={openMachine}/>}
        {view === "fleet" && <FleetView machines={machines} metrics={metrics} loading={loading} fleetError={fleetError} search={searchInput} setSearch={setSearchInput} onSearch={submitSearch} status={status} setStatus={(value) => { setPageNumber(1); setStatus(value); }} category={category} setCategory={(value) => { setPageNumber(1); setCategory(value); }} appliedSearch={search} pageNumber={pageNumber} pageSize={pageSize} setPageNumber={setPageNumber} setPageSize={(value) => { setPageNumber(1); setPageSize(value); }} onOpenMachine={openMachine}/>} 
        {view === "agents" && <AgentCommand result={recommendationResult} loading={intelligenceLoading} onRun={runIntelligence} onOpenMachine={openMachine}/>} 
        {view === "activity" && <ActivityView overview={overview}/>}
        {view === "ingestion" && <IngestionView importing={importing} onFile={ingest}/>}
        {["maintenance", "inventory", "technicians", "incidents"].includes(view) && <PlannedView view={view} description={headings[view][1]}/>}
        <footer className="page-footer"><span>ARQUIFUSION <i/> INTELIGENCIA OPERACIONAL</span><span>PLATAFORMA DE OPERACIONES</span></footer>
      </main>
    </div>
    {selectedMachine && <MachineDialog machine={selectedMachine} onClose={() => setSelectedMachine(null)}/>}
  </div>;
}
