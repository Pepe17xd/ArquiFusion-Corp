import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { fleetApi, apiSession, type AgentEvent, type AgentTask, type FleetMetrics, type Machine, type OperationsOverview, type RecommendationResult } from "./services/api/client";
import { type AppView } from "./components/navigation/NavigationRail";
import { NavigationRail } from "./components/navigation/NavigationRail";
import { TopBar } from "./components/layout/TopBar";
import { FeedbackBanner } from "./components/feedback/FeedbackBanner";
import { CommandCenter } from "./features/dashboard/CommandCenter";
import { FleetView, MachineDialog } from "./features/fleet/FleetView";
import { AgentCommand } from "./features/intelligence/AgentCommand";
import { ActivityView } from "./features/operations/ActivityView";
import { OperationalModule } from "./features/operations/OperationalModule";
import { IngestionView } from "./features/ingestion/IngestionView";
import { IntelligenceWorkbench } from "./features/intelligence/IntelligenceWorkbench";
import { authMode, selectedTenantId, selectedTenantRole, signOut } from "./services/auth/session";
import "./style.css";
import "./supervisor.css";
import "./dashboard-redesign.css";
import "./aura-premium.css";

const headings: Record<AppView, [string, string]> = {
  command: ["Centro de mando", "Estado de la flota, señales actuales e inteligencia operacional en una sola vista."],
  fleet: ["Flota", "Busca e inspecciona la maquinaria registrada."],
  agents: ["Centro de agentes", "Workflow operativo y roles planificados para la plataforma."],
  activity: ["Actividad del sistema", "Estado de la trazabilidad operacional."],
  ingestion: ["Ingesta de datos", "Normaliza registros de flota desde archivos de origen."],
  maintenance: ["Mantenimiento", "Órdenes y estados leídos desde Operations."],
  inventory: ["Inventario", "Stock, reservas y alertas reportados por AURA."],
  technicians: ["Técnicos", "Disponibilidad y especialidades registradas en AURA."],
  incidents: ["Centro de incidentes", "Incidentes y respuesta según los registros disponibles."],
  orchestration: ["Orquestación", "Asignaciones AURA, confirmaciones y eventos persistidos."],
  myPanel: ["Mi panel", "Tus trabajos activos y las siguientes acciones permitidas."],
  myAssignments: ["Mis asignaciones", "Trabajos vinculados a tu cuenta técnica."],
  myMachines: ["Máquinas asignadas", "Equipos asociados exclusivamente a tus trabajos."],
  myMaintenance: ["Mis mantenimientos", "Seguimiento y actualización de tus órdenes."],
  myParts: ["Repuestos solicitados", "Reservas asociadas a tus órdenes asignadas."],
  myHistory: ["Historial personal", "Actividad registrada en tus trabajos."],
};

const technicianViews: AppView[] = ["myPanel", "myAssignments", "myMachines", "myMaintenance", "myParts", "myHistory"];

export default function App() {
  const role = authMode === "local" ? "owner" : selectedTenantRole() ?? "viewer";
  const [view, setView] = useState<AppView>(() => { const target = window.location.hash.slice(1) as AppView; const allowed = role === "technician" ? technicianViews : ["command", "fleet", "agents", "activity", "ingestion", "maintenance", "inventory", "technicians", "incidents", "orchestration"] as AppView[]; return allowed.includes(target) ? target : role === "technician" ? "myPanel" : "command"; });
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [tasksError, setTasksError] = useState("");
  const [eventsError, setEventsError] = useState("");
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
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const taskInFlight = useRef(false);
  const pendingSubmissionKey = useRef<string | null>(null);
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
        if (cursor && seen.has(cursor)) throw new Error("La API devolvió un cursor repetido; no se pudo completar la carga de flota.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return items;
    };
    const [health, page, totals, operations, taskList, eventList] = await Promise.allSettled([fleetApi.health(), allMachines(), fleetApi.metrics(), fleetApi.overview(), fleetApi.tasks(), fleetApi.events()]);

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
    if (taskList.status === "fulfilled") { setTasks(taskList.value); setTasksError(""); }
    else setTasksError(taskList.reason instanceof Error ? taskList.reason.message : "No se pudieron consultar las tareas.");
    if (eventList.status === "fulfilled") { setEvents(eventList.value); setEventsError(""); }
    else setEventsError(eventList.reason instanceof Error ? eventList.reason.message : "No se pudieron consultar los eventos.");
    if (page.status === "fulfilled" || totals.status === "fulfilled") setLastUpdated(new Date());

    const failure = page.status === "rejected" ? page.reason : totals.status === "rejected" ? totals.reason : health.status === "rejected" ? health.reason : undefined;
    if (failure) setError(failure instanceof Error ? failure.message : "No se pudieron cargar los datos de la API.");
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (authMode === "cognito") void apiSession.tenants().then(items => { const found = items.find(item => item.tenant.tenantId === selectedTenantId()); if (found) setOrganization(found.tenant.name); }).catch(() => undefined); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);

  useEffect(() => { if (machines.length && !machines.some((machine) => machine.machineId === selectedMachineId)) setSelectedMachineId(machines[0].machineId); }, [machines, selectedMachineId]);

  const refreshTask = useCallback(async () => {
    if (!task?.taskId) return;
    setIntelligenceError("");
    try {
      const updated = await fleetApi.task(task.taskId);
      setTask(updated);
      if (updated.result) setRecommendationResult(updated.result);
      void load();
    } catch (reason) {
      setIntelligenceError(reason instanceof Error ? reason.message : "No se pudo consultar el estado de la tarea.");
    }
  }, [task?.taskId, load]);

  const runIntelligence = useCallback(async () => {
    if (!selectedMachineId || taskInFlight.current || (task && !["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state))) return;
    taskInFlight.current = true;
    setIntelligenceLoading(true); setError(""); setIntelligenceError(""); setRecommendationResult(null); setTask(null);
    try {
      const requestId = pendingSubmissionKey.current ?? crypto.randomUUID();
      pendingSubmissionKey.current = requestId;
      const submitted = await fleetApi.submitRecommendationTask(requestId, requestId);
      pendingSubmissionKey.current = null;
      let currentTask = submitted.task;
      setTask(currentTask);
      for (let poll = 0; poll < 65 && !["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(currentTask.state); poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        currentTask = await fleetApi.task(currentTask.taskId);
        setTask(currentTask);
      }
      if (currentTask.result) setRecommendationResult(currentTask.result);
      if (["FAILED", "DEAD_LETTER"].includes(currentTask.state)) setIntelligenceError(currentTask.error?.message || "La tarea terminó con error.");
      void load();
    } catch (reason) {
      setIntelligenceError(reason instanceof Error ? reason.message : "No se pudo crear o consultar la tarea.");
    } finally {
      taskInFlight.current = false;
      setIntelligenceLoading(false);
    }
  }, [selectedMachineId, task, load]);

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
    if (role === "technician" && !technicianViews.includes(target)) target = "myPanel";
    if (role !== "technician" && technicianViews.includes(target)) target = "command";
    if (target === "command") { setPageNumber(1); setSearch(""); setSearchInput(""); setStatus(""); setCategory(""); }
    setView(target); setMobileMenu(false);
  }

  return <div className="app-frame">
    <div className="rail-wrap"><NavigationRail view={view} onNavigate={navigate} connected={connected} checking={checking} fleetCount={metrics?.total ?? 0} role={role}/></div>
    <div className="main-column">
      <TopBar view={view} onNavigate={navigate} connected={connected} checking={checking} dateTime={now} onRefresh={() => void load()} refreshing={loading} mobileMenu={mobileMenu} onMenu={() => setMobileMenu((open) => !open)} organization={organization} role={role} onSignOut={authMode === "cognito" ? signOut : undefined}/>
      <main className="content-area">
        {(error || notice) && <FeedbackBanner kind={error ? "error" : "success"} onDismiss={() => { setError(""); setNotice(""); }}>{error || notice}</FeedbackBanner>}
        <div className="page-intro"><div><div className="eyebrow">ARQUIFUSION / OPERACIONES</div><h1>{headings[view][0]}</h1><p>{headings[view][1]}</p></div>{view !== "ingestion" && <span className="data-origin"><span className={`origin-led ${connected ? "online" : checking ? "checking" : "offline"}`}/>{connected ? "DATOS DE API" : checking ? "REVISANDO API" : "API SIN CONEXIÓN"}</span>}</div>
        {view === "command" && <CommandCenter metrics={metrics} machines={machines} total={metrics?.total ?? 0} loading={loading} intelligenceLoading={intelligenceLoading} intelligenceError={intelligenceError} overview={overview} task={task} tasks={tasks} events={events} tasksError={tasksError} eventsError={eventsError} selectedMachineId={selectedMachineId} onSelectMachine={setSelectedMachineId} connected={connected} checking={checking} lastUpdated={lastUpdated} organization={organization} onRun={runIntelligence} onRefreshTask={refreshTask} onNavigate={navigate} onOpenMachine={openMachine}/>}
        {view === "fleet" && <FleetView machines={machines} metrics={metrics} loading={loading} fleetError={fleetError} search={searchInput} setSearch={setSearchInput} onSearch={submitSearch} status={status} setStatus={(value) => { setPageNumber(1); setStatus(value); }} category={category} setCategory={(value) => { setPageNumber(1); setCategory(value); }} appliedSearch={search} pageNumber={pageNumber} pageSize={pageSize} setPageNumber={setPageNumber} setPageSize={(value) => { setPageNumber(1); setPageSize(value); }} onOpenMachine={openMachine}/>} 
        {view === "agents" && <AgentCommand result={recommendationResult} loading={intelligenceLoading} onRun={runIntelligence} onOpenMachine={openMachine} machines={machines} task={task} error={intelligenceError} selectedMachineId={selectedMachineId} onSelectMachine={setSelectedMachineId} onRefreshTask={refreshTask}/>}
        {view === "activity" && <ActivityView events={events} error={eventsError} loading={loading}/>}
        {view === "ingestion" && <IngestionView importing={importing} onFile={ingest}/>}
        {["maintenance", "inventory", "technicians", "incidents", "orchestration", ...technicianViews].includes(view) && <OperationalModule view={view} onNavigate={navigate} role={role}/>}
        <footer className="page-footer"><span>ARQUIFUSION <i/> INTELIGENCIA OPERACIONAL</span><span>PLATAFORMA DE OPERACIONES</span></footer>
      </main>
    </div>
    {selectedMachine && <MachineDialog machine={selectedMachine} onClose={() => setSelectedMachine(null)}/>}
  </div>;
}
