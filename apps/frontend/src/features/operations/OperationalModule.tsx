import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Activity, AlertTriangle, ArrowRight, Check, Circle, Clock3, RefreshCw, Sparkles, Wrench } from "lucide-react";
import { auraApi, fleetApi, operationsApi, type ApiPage, type AuraAssignment, type AuraKpis, type AuraTechnician, type InventoryBalance, type InventoryMovement, type InventoryPart, type Machine, type OperationalItem, type TechnicianWorkOrder } from "../../services/api/client";
import { selectedTenantId } from "../../services/auth/session";
import type { AppView } from "../../components/navigation/NavigationRail";
import { FormSection, TextAreaField } from "../../components/ui/DesignPrimitives";
import { DataTable as Table } from "../../components/ui/DataTable";
import { moduleLoadState } from "./module-state";
import { toUserMessage } from "../../services/api/user-message";
import { toEventLabel } from "../../services/api/user-copy";
import { isLocalPreview } from "../../services/runtime-mode";

type ProposedAssignment = AuraAssignment & { candidates?: Array<{ technicianId: string; cost: number; breakdown: Record<string, number> }>; version?: number };
type Data = { incidents?: ApiPage<OperationalItem>; anomalies?: ApiPage<OperationalItem>; orders?: ApiPage<OperationalItem>; technicians?: ApiPage<AuraTechnician>; parts?: ApiPage<InventoryPart>; stock?: ApiPage<InventoryBalance>; alerts?: ApiPage<Record<string, unknown>>; movements?: ApiPage<InventoryMovement>; assignments?: ApiPage<AuraAssignment>; events?: ApiPage<OperationalItem>; kpis?: AuraKpis; profile?: AuraTechnician; myOrders?: ApiPage<TechnicianWorkOrder>; machines?: Machine[] };
type Analysis = { source: string; recommendations: Array<{ title: string; reason: string; suggestedAction: string }>; evidence: Record<string, unknown> | null; explanationAvailable?: boolean };
const technicianViews = new Set<AppView>(["myPanel", "myAssignments", "myMachines", "myMaintenance", "myParts", "myHistory"]);
const titles: Partial<Record<AppView, string>> = { maintenance: "Órdenes de mantenimiento", inventory: "Inventario y disponibilidad", technicians: "Equipo técnico", incidents: "Incidentes activos", orchestration: "Coordinación AURA", myPanel: "Mi panel técnico", myAssignments: "Mis asignaciones", myMachines: "Máquinas de mis trabajos", myMaintenance: "Mis mantenimientos", myParts: "Repuestos solicitados", myHistory: "Mi historial" };

export function OperationalModule({ view, onNavigate, role }: { view: AppView; onNavigate: (view: AppView) => void; role: string }) {
  const [data, setData] = useState<Data>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [proposal, setProposal] = useState<ProposedAssignment[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Record<string, Analysis>>({});
  const [analysisBusy, setAnalysisBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [techForm, setTechForm] = useState({ technicianId: "", displayName: "", email: "", specialties: "", skills: "", capacity: "1", availability: "available", days: "1,2,3,4,5", start: "08:00", end: "17:00", timeZone: "America/Lima" });
  const [partForm, setPartForm] = useState({ partId: "", name: "", sku: "", unit: "each", minimumStock: "0" });
  const [incidentForm, setIncidentForm] = useState({ machineId: "", type: "Mechanical", severity: "warning" as "info" | "warning" | "critical", description: "" });
  const [editingPartVersion, setEditingPartVersion] = useState<number | null>(null);
  const [movementForm, setMovementForm] = useState({ partId: "", locationId: "", quantity: "", reason: "" });
  const [formBusy, setFormBusy] = useState(false);
  const idempotency = useRef<string | null>(null);
  const invitationKey = useRef<string | null>(null);
  const incidentKey = useRef<string | null>(null);
  const approvalKeys = useRef(new Map<string, string>());
  const [editingTechnicianVersion, setEditingTechnicianVersion] = useState<number | null>(null);
  const isTechnician = role === "technician" && technicianViews.has(view);

  const load = useCallback(async () => {
    if (isLocalPreview) { setData({}); setLoading(false); setError(""); setNotice(""); return; }
    setLoading(true); setError(""); setNotice("");
    try {
      let next: Data;
      if (technicianViews.has(view)) {
        const [profile, myOrders] = await Promise.all([auraApi.myProfile(), auraApi.myWorkOrders()]);
        next = { profile, myOrders };
      } else if (view === "incidents") {
        const [incidents, anomalies] = await Promise.all([operationsApi.incidents(), operationsApi.anomalies()]);
        const machines: Machine[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const params = new URLSearchParams({ limit: "100" }); if (cursor) params.set("cursor", cursor);
          const page = await fleetApi.machines(params); machines.push(...page.items); cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("No pudimos actualizar la flota."); if (cursor) cursors.add(cursor);
        } while (cursor);
        next = { incidents, anomalies, machines };
      } else if (view === "maintenance") next = { orders: await operationsApi.maintenance() };
      else if (view === "technicians") next = { technicians: await auraApi.technicians() };
      else if (view === "inventory") {
        const values = await Promise.all([auraApi.parts(), auraApi.stock(), auraApi.inventoryAlerts(), auraApi.movements()]);
        next = { parts: values[0], stock: values[1], alerts: values[2], movements: values[3] };
      } else if (view === "orchestration") {
        const to = new Date(), from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
        const values = await Promise.all([auraApi.assignments(), auraApi.events(), auraApi.kpis(from.toISOString(), to.toISOString())]);
        next = { assignments: values[0], events: values[1], kpis: values[2] };
      } else next = {};
      setData(next);
    } catch (reason) {
      setData({}); setError(toUserMessage(reason, "No pudimos actualizar esta información."));
    } finally { setLoading(false); }
  }, [view]);

  useEffect(() => { void load(); setSelected([]); setProposal([]); setChoice({}); idempotency.current = null; }, [load]);
  const incidents = data.incidents?.items ?? [];
  const filteredIncidents = useMemo(() => incidents.filter((item) => `${item.entityId} ${item.machineId ?? ""} ${item.title ?? ""}`.toLowerCase().includes(search.toLowerCase())), [incidents, search]);
  const recordCount = technicianViews.has(view) ? data.myOrders?.items.length ?? 0 : view === "incidents" ? incidents.length : view === "maintenance" ? data.orders?.items.length ?? 0 : view === "technicians" ? data.technicians?.items.length ?? 0 : view === "inventory" ? data.stock?.items.length ?? 0 : data.assignments?.items.length ?? 0;
  const state = moduleLoadState({ loading, error, recordCount });

  async function optimize() {
    if (!selected.length || optimizing || role === "technician") return;
    setOptimizing(true); setError(""); setNotice(""); idempotency.current ??= crypto.randomUUID();
    try {
      const response = await auraApi.optimize(selected, idempotency.current, false);
      setProposal(response.assignments); setChoice(Object.fromEntries(response.assignments.map((item) => [item.assignmentId, item.technicianId ?? ""])));
      setNotice(response.replayed ? "Se recuperó la recomendación guardada para esta solicitud." : "Recomendación AURA calculada. Confirma una asignación para iniciar el proceso.");
      idempotency.current = null; setSelected([]); await load();
    } catch (reason) { setError(toUserMessage(reason, "No pudimos generar la recomendación.")); }
    finally { setOptimizing(false); }
  }

  async function approve(assignment: ProposedAssignment) {
    if (approvalBusy) return;
    setApprovalBusy(assignment.assignmentId); setError("");
    const key = approvalKeys.current.get(assignment.assignmentId) ?? crypto.randomUUID();
    approvalKeys.current.set(assignment.assignmentId, key);
    try {
      const selectedTechnician = choice[assignment.assignmentId] || undefined;
      const response = await auraApi.approveAssignment(assignment.assignmentId, selectedTechnician, assignment.version, key);
      approvalKeys.current.delete(assignment.assignmentId);
      setNotice(response.workflowStarted ? "Asignación aprobada y proceso iniciado." : "Aprobación guardada. El seguimiento estará disponible cuando se habilite.");
      setProposal((items) => items.filter((item) => item.assignmentId !== assignment.assignmentId)); await load();
    } catch (reason) { setError(toUserMessage(reason, "No pudimos aprobar la asignación.")); }
    finally { setApprovalBusy(null); }
  }

  async function explain(anomalyId: string, workOrderId?: string) {
    setAnalysisBusy(workOrderId ?? anomalyId); setError("");
    try {
      const response = workOrderId ? await auraApi.explainMyWorkOrder(workOrderId) : await operationsApi.explainAnomaly(anomalyId);
      setAnalysis((current) => ({ ...current, [workOrderId ?? anomalyId]: response }));
    } catch (reason) { setError(toUserMessage(reason, "No pudimos obtener el análisis.")); }
    finally { setAnalysisBusy(null); }
  }

  async function technicianAction(order: TechnicianWorkOrder, action: "start" | "block" | "complete") {
    if (actionBusy) return;
    const note = notes[order.entityId] ?? "";
    if (action !== "start" && !note.trim()) { setError("Añade una observación antes de bloquear o completar el trabajo."); return; }
    setActionBusy(order.entityId); setError(""); setNotice("");
    try {
      if (action === "start") await auraApi.startMyWorkOrder(order.entityId);
      else if (action === "block") await auraApi.blockMyWorkOrder(order.entityId, note);
      else await auraApi.completeMyWorkOrder(order.entityId, note);
      setNotes((current) => ({ ...current, [order.entityId]: "" }));
      setNotice(action === "complete" ? "Trabajo enviado para revisión administrativa." : action === "block" ? "Trabajo bloqueado y observación registrada." : "Trabajo iniciado y auditado.");
      await load();
    } catch (reason) { setError(toUserMessage(reason, "No pudimos actualizar el trabajo.")); }
    finally { setActionBusy(null); }
  }

  async function reservePart(event: FormEvent<HTMLFormElement>, order: TechnicianWorkOrder) {
    event.preventDefault(); if (formBusy) return;
    const form = new FormData(event.currentTarget);
    const input = { partId: String(form.get("partId") ?? ""), locationId: String(form.get("locationId") ?? ""), quantity: Number(form.get("quantity")), reason: String(form.get("reason") ?? "") };
    setFormBusy(true); setError("");
    try { await auraApi.reserveMyPart(order.entityId, input, crypto.randomUUID()); setNotice("Reserva registrada para esta orden."); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos reservar el repuesto.")); }
    finally { setFormBusy(false); }
  }

  async function consumeReservation(order: TechnicianWorkOrder, reservationId: string) {
    if (actionBusy) return;
    setActionBusy(reservationId); setError("");
    try { await auraApi.consumeMyReservation(order.entityId, reservationId); setNotice("Consumo registrado en inventario y en la orden."); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos registrar el consumo.")); }
    finally { setActionBusy(null); }
  }

  async function review(order: OperationalItem, decision: "approve" | "return") {
    const review = reviewNotes[order.entityId] ?? "";
    if (!review.trim()) { setError("Añade el motivo de revisión antes de continuar."); return; }
    if (!window.confirm(decision === "approve" ? "¿Aprobar el mantenimiento y cerrar el incidente vinculado?" : "¿Devolver el trabajo al técnico para continuar?") || formBusy) return;
    setFormBusy(true); setError(""); setNotice("");
    try { await auraApi.reviewWorkOrder(order.entityId, decision, review); setReviewNotes((current) => ({ ...current, [order.entityId]: "" })); setNotice(decision === "approve" ? "Mantenimiento aprobado; incidente cerrado." : "Trabajo devuelto al técnico con observaciones."); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos guardar la revisión.")); }
    finally { setFormBusy(false); }
  }

  async function createTechnician(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (formBusy) return;
    const tenantId = selectedTenantId(); if (!tenantId) { setError("Selecciona una organización antes de crear el perfil."); return; }
    const dayValues = techForm.days.split(",").map((value) => Number(value.trim()));
    if (dayValues.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) { setError("Los días deben ser números de 0 (domingo) a 6 (sábado). Vuelve a revisar el campo."); return; }
    const specialties = techForm.specialties.split(",").map((value) => value.trim()).filter(Boolean);
    const skills = techForm.skills.split(",").map((value) => { const [code, levelText, ...rest] = value.trim().split(":"); return { code: code?.trim() ?? "", level: Number(levelText ?? "1"), invalid: rest.length > 0 }; });
    if (!specialties.length || !skills.length || skills.some((skill) => !/^[a-zA-Z0-9._:-]{1,64}$/.test(skill.code) || !Number.isInteger(skill.level) || skill.level < 1 || skill.level > 5 || skill.invalid)) { setError("Indica especialidades separadas por coma y habilidades como codigo:nivel (1–5)."); return; }
    setFormBusy(true); setError(""); setNotice("");
    try {
      const technician = { technicianId: techForm.technicianId.trim(), displayName: techForm.displayName.trim(), specialties, skills: skills.map(({ code, level }) => ({ code, level })), availability: techForm.availability as "available" | "unavailable", maxConcurrentAssignments: Number(techForm.capacity), shifts: [{ daysOfWeek: [...new Set(dayValues)], startTime: techForm.start, endTime: techForm.end, timeZone: techForm.timeZone }] };
      if (editingTechnicianVersion !== null) {
        await auraApi.updateTechnician(technician, editingTechnicianVersion);
        setNotice("Perfil técnico actualizado con control de versión.");
      } else {
        invitationKey.current ??= crypto.randomUUID();
        await auraApi.inviteTechnician(tenantId, { ...technician, email: techForm.email.trim().toLowerCase() }, invitationKey.current);
        invitationKey.current = null;
        setNotice("Invitación Cognito enviada y perfil vinculado a esta organización.");
      }
      setEditingTechnicianVersion(null);
      setTechForm({ technicianId: "", displayName: "", email: "", specialties: "", skills: "", capacity: "1", availability: "available", days: "1,2,3,4,5", start: "08:00", end: "17:00", timeZone: "America/Lima" });
      await load();
    } catch (reason) { setError(toUserMessage(reason, "No pudimos guardar el perfil técnico.")); }
    finally { setFormBusy(false); }
  }

  function editTechnician(technician: AuraTechnician) {
    const shift = technician.shifts?.[0];
    setEditingTechnicianVersion(technician.version);
    setTechForm({ technicianId: technician.technicianId, displayName: technician.displayName, email: "", specialties: technician.specialties.join(", "), skills: technician.skills.map((skill) => `${skill.code}:${skill.level}`).join(", "), capacity: String(technician.maxConcurrentAssignments), availability: technician.availability, days: shift?.daysOfWeek.join(",") ?? "1,2,3,4,5", start: shift?.startTime ?? "08:00", end: shift?.endTime ?? "17:00", timeZone: shift?.timeZone ?? "America/Lima" });
  }

  async function archiveTechnician(technician: AuraTechnician) {
    if (!window.confirm(`¿Desactivar el perfil ${technician.displayName}?`)) return;
    setActionBusy(technician.technicianId); setError("");
    try { await auraApi.archiveTechnician(technician.technicianId, technician.version); setNotice("Perfil desactivado; su asociación técnica ya no podrá acceder al panel."); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos desactivar el perfil.")); }
    finally { setActionBusy(null); }
  }

  async function createPart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (formBusy) return;
    setFormBusy(true); setError("");
    try {
      const part = { ...partForm, minimumStock: Number(partForm.minimumStock) };
      if (editingPartVersion === null) { await auraApi.createPart(part); setNotice("Repuesto agregado al catálogo."); }
      else { await auraApi.updatePart(part, editingPartVersion); setNotice("Ficha del repuesto actualizada con control de versión."); }
      setEditingPartVersion(null); setPartForm({ partId: "", name: "", sku: "", unit: "each", minimumStock: "0" }); await load();
    }
    catch (reason) { setError(toUserMessage(reason, "No pudimos guardar el repuesto.")); }
    finally { setFormBusy(false); }
  }

  async function recordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (formBusy) return;
    const input = { partId: movementForm.partId, locationId: movementForm.locationId, quantity: Number(movementForm.quantity), kind: "receipt" as const, reason: movementForm.reason };
    setFormBusy(true); setError("");
    try { await auraApi.movement(input, crypto.randomUUID()); setNotice("Ingreso de stock auditado."); setMovementForm({ partId: "", locationId: "", quantity: "", reason: "" }); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos actualizar las existencias.")); }
    finally { setFormBusy(false); }
  }

  async function createIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (formBusy) return;
    incidentKey.current ??= crypto.randomUUID(); setFormBusy(true); setError("");
    try {
      const result = await operationsApi.createIncident({ ...incidentForm, machineId: incidentForm.machineId.trim(), type: incidentForm.type.trim(), description: incidentForm.description.trim() }, incidentKey.current);
      incidentKey.current = null; setIncidentForm({ machineId: "", type: "Mechanical", severity: "warning", description: "" });
      setNotice(result.replayed ? "Se recuperó el incidente creado para esta solicitud." : "Incidente manual creado y auditado."); await load();
    } catch (reason) { setError(toUserMessage(reason, "No pudimos crear el incidente.")); }
    finally { setFormBusy(false); }
  }

  async function createOrderForIncident(incidentId: string) {
    if (actionBusy) return; setActionBusy(incidentId); setError("");
    try { const result = await operationsApi.createMaintenanceFromIncident(incidentId); setNotice(result.replayed ? "La orden existente se recuperó." : "Orden correctiva creada desde el incidente; Gemini no es requisito."); await load(); }
    catch (reason) { setError(toUserMessage(reason, "No pudimos crear la orden.")); }
    finally { setActionBusy(null); }
  }

  return <section className="module-shell" aria-labelledby="module-title">
    <header className="module-header"><div><span className="module-kicker"><Activity size={13}/> ARQUIFUSION / {view.toUpperCase()}</span><h2 id="module-title">{titles[view] ?? "Operaciones"}</h2><p>{isTechnician ? "Aquí verás solo los trabajos asignados a tu cuenta." : "Consulta la información disponible para esta organización."}</p></div><button className="module-refresh" onClick={() => void load()} disabled={loading} aria-label="Actualizar módulo"><RefreshCw size={15}/><span>Actualizar</span></button></header>
    {error && <div className="module-banner module-banner-error" role="alert"><AlertTriangle size={17}/><div><b>{error}</b><p>Revisa la información y vuelve a intentarlo.</p></div><button onClick={() => void load()}>Volver a intentar</button></div>}
    {notice && <div className="module-result" role="status"><Check size={16}/><span>{notice}</span></div>}
    {state === "loading" ? <div className="module-skeleton" role="status" aria-label="Cargando módulo"><i/><i/><i/></div> : state !== "error" && <>
      {view === "incidents" && <>
        {(role === "admin" || role === "owner") && <form className="module-form incident-form" onSubmit={(event) => void createIncident(event)}>
          <div><span className="module-kicker">REGISTRO ADMINISTRATIVO</span><h3>Registrar incidente</h3><p>Alta persistida. Puedes iniciar mantenimiento aunque Gemini no haya generado recomendaciones.</p></div>
          <div className="module-form-grid">
            <label>Máquina<select required value={incidentForm.machineId} onChange={(event) => setIncidentForm((form) => ({ ...form, machineId: event.target.value }))}><option value="">Seleccionar maquinaria registrada</option>{data.machines?.map((machine) => <option key={machine.machineId} value={machine.machineId}>{machine.machineId} · {machine.model} · {machine.location}</option>)}</select></label>
            <Field label="Tipo de incidente" value={incidentForm.type} onChange={(value) => setIncidentForm((form) => ({ ...form, type: value }))} required/>
            <label>Severidad<select value={incidentForm.severity} onChange={(event) => setIncidentForm((form) => ({ ...form, severity: event.target.value as "info" | "warning" | "critical" }))}><option value="info">Informativa</option><option value="warning">Advertencia</option><option value="critical">Crítica</option></select></label>
            <TextAreaField label="Descripción y evidencia disponible" value={incidentForm.description} onChange={(event) => setIncidentForm((form) => ({ ...form, description: event.target.value }))} required rows={3}/>
          </div>
          <button className="module-primary" disabled={formBusy || !data.machines?.length}>{formBusy ? "Guardando…" : "Crear incidente"}</button>
        </form>}
        <div className="module-toolbar"><label className="module-search">Buscar incidente<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, máquina o título"/></label><span>{incidents.length} registros recibidos</span><button className="module-primary" onClick={() => void optimize()} disabled={!selected.length || optimizing || role === "technician"}><Sparkles size={15}/>{optimizing ? "Calculando…" : `Generar recomendación AURA${selected.length ? ` · ${selected.length}` : ""}`}</button></div>
        <p className="module-hint">La recomendación se calcula primero. Solo el administrador puede aprobar un candidato y arrancar el proceso.</p>
        <div className="module-table-wrap"><table className="module-table"><thead><tr><th>Coordinar</th><th>Incidente</th><th>Máquina</th><th>Severidad</th><th>Estado</th><th>Creado</th><th>Diagnóstico</th><th>Mantenimiento</th></tr></thead><tbody>{filteredIncidents.map((item) => {
          const anomalyId = String(item.anomalyId ?? ""); const details = anomalyId ? analysis[anomalyId] : undefined;
          return <tr key={item.entityId}><td><input type="checkbox" aria-label={`Seleccionar ${item.entityId}`} checked={selected.includes(item.entityId)} disabled={!(["open", "acknowledged"].includes(String(item.status)) && role !== "technician")} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.entityId] : current.filter((id) => id !== item.entityId))}/></td><td><b>{item.title || item.entityId}</b><small>{item.entityId}</small></td><td>{item.machineId || "—"}</td><td><Pill value={String(item.severity ?? "Sin severidad")}/></td><td><Pill value={String(item.status ?? "unknown")}/></td><td>{dateLabel(item.createdAt)}</td><td>{anomalyId ? <button className="module-link" onClick={() => void explain(anomalyId)} disabled={analysisBusy === anomalyId}>{analysisBusy === anomalyId ? "Analizando…" : details ? `Origen: ${details.source}` : "Analizar evidencia"}</button> : <span>Sin anomalía vinculada</span>}</td></tr>;
        })}</tbody></table>{!filteredIncidents.length && <Empty text={incidents.length ? "No hay coincidencias para la búsqueda." : "No hay incidentes en los registros recibidos."}/>}</div>
        {filteredIncidents.map((item) => { const id = String(item.anomalyId ?? ""), result = id ? analysis[id] : undefined; return result ? <AnalysisCard key={id} analysis={result} title={`Análisis ${id}`} /> : null; })}
        {(role === "admin" || role === "owner") && incidents.filter((item) => !item.workOrderId).length > 0 && <section className="module-proposals"><div className="module-subheading"><h3>Crear mantenimiento desde incidente</h3><span>Disponible aunque no exista análisis Gemini</span></div>{incidents.filter((item) => !item.workOrderId).map((item) => <article className="proposal-row" key={`maintenance-${item.entityId}`}><div><b>{String(item.title ?? item.entityId)}</b><small>{String(item.machineId ?? "") } · {String(item.severity ?? "")}</small></div><button onClick={() => void createOrderForIncident(item.entityId)} disabled={actionBusy === item.entityId}>{actionBusy === item.entityId ? "Creando…" : "Crear orden correctiva"}</button></article>)}</section>}
        {!!proposal.length && <section className="module-proposals"><div className="module-subheading"><h3>Recomendaciones pendientes de aprobación</h3><span>Costo global normalizado por AURA</span></div>{proposal.map((assignment) => <article className="proposal-row" key={assignment.assignmentId}><div><b>{assignment.incidentId}</b><small>{assignment.machineId} · {assignment.severity} · costo {assignment.cost.toFixed(3)}</small></div><select aria-label={`Técnico para ${assignment.incidentId}`} value={choice[assignment.assignmentId] ?? ""} onChange={(event) => setChoice((current) => ({ ...current, [assignment.assignmentId]: event.target.value }))}><option value="">Sin técnico elegible</option>{assignment.candidates?.map((candidate) => <option key={candidate.technicianId} value={candidate.technicianId}>{candidate.technicianId} · {candidate.cost.toFixed(3)}</option>)}</select><button className="module-primary" disabled={!choice[assignment.assignmentId] || !["admin", "owner"].includes(role) || approvalBusy !== null} onClick={() => void approve(assignment)}>{approvalBusy === assignment.assignmentId ? "Aprobando…" : "Aprobar y asignar"}</button><div className="assignment-cost-factors">{Object.entries(assignment.costBreakdown ?? {}).map(([key, value]) => <span key={key}>{key}: {value.toFixed(2)}</span>)}</div></article>)}</section>}
      </>}
      {view === "maintenance" && <><Table items={data.orders?.items ?? []} headers={["Orden", "Máquina", "Prioridad", "Estado", "Actualizada", "Revisión"]} empty="No hay órdenes de mantenimiento." render={(item) => [<><b>{String(item.title ?? item.entityId)}</b><small>{item.entityId}</small></>, String(item.machineId ?? "—"), String(item.priority ?? "—"), <Pill value={String(item.status ?? "unknown")}/>, dateLabel(item.updatedAt), item.status === "completed" ? <div className="review-actions"><input aria-label={`Observación de revisión ${item.entityId}`} value={reviewNotes[item.entityId] ?? ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [item.entityId]: event.target.value }))} placeholder="Observación"/><button onClick={() => void review(item, "approve")} disabled={formBusy}>Aprobar</button><button onClick={() => void review(item, "return")} disabled={formBusy}>Devolver</button></div> : "—"]}/></>}
      {view === "technicians" && <>
        {role === "admin" || role === "owner" ? <form className="module-form technician-form" onSubmit={(event) => void createTechnician(event)}>
          <div className="technician-form-heading"><div><span className="module-kicker">CUENTAS Y CAPACIDADES</span><h3>{editingTechnicianVersion === null ? "Invitar técnico por correo" : "Editar perfil técnico"}</h3><p>{editingTechnicianVersion === null ? "Cognito enviará su invitación. La identidad se vincula con el sub devuelto por Cognito; no introduzcas una contraseña." : "Actualización protegida por If-Match. No cambia la identidad vinculada."}</p></div></div>
          <FormSection title="Identidad" description="Datos de perfil para asociar la cuenta invitada al técnico.">
            <Field label="ID técnico" value={techForm.technicianId} onChange={(value) => setTechForm((form) => ({ ...form, technicianId: value }))} required/>
            <Field label="Nombre visible" value={techForm.displayName} onChange={(value) => setTechForm((form) => ({ ...form, displayName: value }))} required/>
            {editingTechnicianVersion === null && <Field label="Correo de invitación" type="email" value={techForm.email} onChange={(value) => setTechForm((form) => ({ ...form, email: value }))} required/>}
          </FormSection>
          <FormSection title="Especialidades y habilidades" description="Usa códigos compatibles con las reglas de asignación AURA.">
            <Field label="Especialidades separadas por coma" value={techForm.specialties} onChange={(value) => setTechForm((form) => ({ ...form, specialties: value }))} required/>
            <Field label="Habilidades código:nivel separadas por coma" value={techForm.skills} onChange={(value) => setTechForm((form) => ({ ...form, skills: value }))} required/>
            <Field label="Capacidad simultánea" type="number" value={techForm.capacity} onChange={(value) => setTechForm((form) => ({ ...form, capacity: value }))} required/>
          </FormSection>
          <FormSection title="Disponibilidad y turno">
            <label className="module-form-label">Disponibilidad<select value={techForm.availability} onChange={(event) => setTechForm((form) => ({ ...form, availability: event.target.value }))}><option value="available">Disponible</option><option value="unavailable">No disponible</option></select></label>
            <Field label="Días 0–6" value={techForm.days} onChange={(value) => setTechForm((form) => ({ ...form, days: value }))} required/>
            <Field label="Inicio local" type="time" value={techForm.start} onChange={(value) => setTechForm((form) => ({ ...form, start: value }))} required/>
            <Field label="Fin local" type="time" value={techForm.end} onChange={(value) => setTechForm((form) => ({ ...form, end: value }))} required/>
            <Field label="Zona horaria" value={techForm.timeZone} onChange={(value) => setTechForm((form) => ({ ...form, timeZone: value }))} required/>
          </FormSection>
          <div className="technician-form-actions"><button className="module-primary" disabled={formBusy}>{formBusy ? "Guardando…" : editingTechnicianVersion === null ? "Invitar y crear perfil" : "Guardar cambios"}</button>{editingTechnicianVersion !== null && <button type="button" className="module-refresh" onClick={() => { setEditingTechnicianVersion(null); setTechForm({ technicianId: "", displayName: "", email: "", specialties: "", skills: "", capacity: "1", availability: "available", days: "1,2,3,4,5", start: "08:00", end: "17:00", timeZone: "America/Lima" }); }}>Cancelar edición</button>}</div>
        </form> : <Empty text="La gestión de perfiles está reservada a administradores de la organización."/>}
        <div className="module-metrics"><Metric label="Técnicos" value={String(data.technicians?.items.length ?? 0)}/><Metric label="Disponibles" value={String(data.technicians?.items.filter((item) => item.availability === "available").length ?? 0)}/><Metric label="Habilidades" value={String(new Set(data.technicians?.items.flatMap((item) => item.skills.map((skill) => skill.code)) ?? []).size)}/></div><Table items={(data.technicians?.items ?? []) as unknown as OperationalItem[]} headers={["Técnico", "Disponibilidad", "Especialidades", "Habilidades", "Capacidad", "Acción"]} empty="No hay perfiles técnicos registrados." render={(item) => { const tech = item as unknown as AuraTechnician; return [<><b>{tech.displayName}</b><small>{tech.technicianId}</small></>, <Pill value={tech.availability}/>, tech.specialties.join(" · "), tech.skills.map((skill) => `${skill.code} L${skill.level}`).join(" · "), String(tech.maxConcurrentAssignments), role === "admin" || role === "owner" ? <div className="module-action-row"><button onClick={() => editTechnician(tech)}>Editar</button>{tech.status !== "inactive" && <button onClick={() => void archiveTechnician(tech)} disabled={actionBusy === tech.technicianId}>Desactivar</button>}</div> : "—"]; }}/>
      </>}
      {view === "inventory" && <>
        {(role === "admin" || role === "owner") && <div className="module-admin-grid"><form className="module-form" onSubmit={(event) => void createPart(event)}><h3>{editingPartVersion === null ? "Nuevo repuesto" : "Editar repuesto"}</h3><div className="module-form-grid"><Field label="ID" value={partForm.partId} onChange={(value) => setPartForm((form) => ({ ...form, partId: value }))} required disabled={editingPartVersion !== null}/><Field label="Nombre" value={partForm.name} onChange={(value) => setPartForm((form) => ({ ...form, name: value }))} required/><Field label="SKU" value={partForm.sku} onChange={(value) => setPartForm((form) => ({ ...form, sku: value }))} required/><Field label="Unidad" value={partForm.unit} onChange={(value) => setPartForm((form) => ({ ...form, unit: value }))} required/><Field label="Stock mínimo" type="number" value={partForm.minimumStock} onChange={(value) => setPartForm((form) => ({ ...form, minimumStock: value }))} required/></div><button className="module-primary" disabled={formBusy}>{editingPartVersion === null ? "Agregar al catálogo" : "Guardar cambios"}</button></form><form className="module-form" onSubmit={(event) => void recordMovement(event)}><h3>Ingreso de stock</h3><div className="module-form-grid"><label>Repuesto<select required value={movementForm.partId} onChange={(event) => setMovementForm((form) => ({ ...form, partId: event.target.value }))}><option value="">Seleccionar</option>{data.parts?.items.map((part) => <option key={part.partId} value={part.partId}>{part.name} ({part.sku})</option>)}</select></label><Field label="Ubicación" value={movementForm.locationId} onChange={(value) => setMovementForm((form) => ({ ...form, locationId: value }))} required/><Field label="Cantidad" type="number" value={movementForm.quantity} onChange={(value) => setMovementForm((form) => ({ ...form, quantity: value }))} required/><Field label="Motivo" value={movementForm.reason} onChange={(value) => setMovementForm((form) => ({ ...form, reason: value }))} required/></div><button className="module-primary" disabled={formBusy || !data.parts?.items.length}>Registrar ingreso</button></form></div>}
        <div className="module-metrics"><Metric label="Repuestos" value={String(data.parts?.items.length ?? 0)}/><Metric label="Ubicaciones" value={String(new Set(data.stock?.items.map((item) => item.locationId) ?? []).size)}/><Metric label="Alertas bajo mínimo" value={String(data.alerts?.items.length ?? 0)} tone={data.alerts?.items.length ? "warning" : ""}/></div>
        <Table items={(data.parts?.items ?? []) as unknown as OperationalItem[]} headers={["Catálogo", "SKU", "Unidad", "Stock mínimo", "Acción"]} empty="No hay repuestos en el catálogo." render={(item) => { const part = item as unknown as InventoryPart; return [<><b>{part.name}</b><small>{part.partId}</small></>, part.sku, part.unit, String(part.minimumStock), role === "admin" || role === "owner" ? <button onClick={() => { setEditingPartVersion(part.version); setPartForm({ partId: part.partId, name: part.name, sku: part.sku, unit: part.unit, minimumStock: String(part.minimumStock) }); }}>Editar</button> : "—"]; }}/>
        {!!data.alerts?.items.length && <div className="inventory-alerts">{data.alerts.items.map((item, index) => <article key={String(item.partId) + index}><AlertTriangle size={15}/><b>{String(item.name ?? item.partId)}</b><span>{String(item.locationId)} · disponible {String(item.available)} / mínimo {String(item.minimumStock)}</span></article>)}</div>}
        <Table items={(data.stock?.items ?? []) as unknown as OperationalItem[]} headers={["Repuesto", "SKU", "Ubicación", "En mano", "Reservado", "Disponible"]} empty="No hay saldos de inventario." render={(item) => { const part = data.parts?.items.find((row) => row.partId === item.partId); return [<><b>{part?.name ?? String(item.partId)}</b><small>{String(item.partId)}</small></>, part?.sku ?? "—", String(item.locationId), String(item.onHand), String(item.reserved), String(Number(item.onHand) - Number(item.reserved))]; }}/>
        <div className="module-subheading"><h3>Movimientos de inventario</h3><span>Últimos registros persistidos</span></div>
        <Table items={(data.movements?.items ?? []) as unknown as OperationalItem[]} headers={["Fecha", "Repuesto", "Ubicación", "Tipo", "Cantidad", "Motivo"]} empty="No hay movimientos de inventario." render={(item) => { const movement = item as unknown as InventoryMovement; const part = data.parts?.items.find((row) => row.partId === movement.partId); return [dateLabel(movement.createdAt), <><b>{part?.name ?? movement.partId}</b><small>{movement.partId}</small></>, movement.locationId, movement.kind === "receipt" ? "Ingreso" : movement.kind, String(movement.quantity), movement.reason]; }}/>
      </>}
      {view === "orchestration" && <><div className="module-metrics"><Metric label="MTTR · periodo consultado" title="Tiempo medio para resolver una incidencia" value={data.kpis?.mttr.averageMinutes == null ? "—" : `${Math.round(data.kpis.mttr.averageMinutes)} min`}/><Metric label="Reincidencia · 30 días" value={data.kpis?.recurrence.percent == null ? "—" : `${data.kpis.recurrence.percent}%`}/><Metric label="Tiempo detenido" value={data.kpis?.downtime.totalMinutes == null ? "No disponible" : `${Math.round(data.kpis.downtime.totalMinutes)} min`}/></div><div className="workflow-summary"><div><span>ASIGNACIONES</span><b>{data.assignments?.items.length ?? 0}</b></div><div><span>EN ATENCIÓN</span><b>{data.assignments?.items.filter((item) => item.status === "in_progress").length ?? 0}</b></div><div><span>EVENTOS AURA</span><b>{data.events?.items.length ?? 0}</b></div></div><div className="workflow-list">{data.assignments?.items.map((assignment) => <WorkflowCard key={assignment.assignmentId} assignment={assignment} onOpenIncidents={() => onNavigate("incidents")}/>)}{!data.assignments?.items.length && <Empty text="No hay procesos de asignación."/>}</div><div className="module-subheading"><h3>Actividad registrada</h3><span>El registro de un evento no confirma la entrega de avisos externos.</span></div><Timeline items={data.events?.items ?? []}/></>}
      {technicianViews.has(view) && <TechnicianContent view={view} data={data} notes={notes} setNotes={setNotes} actionBusy={actionBusy} analysis={analysis} analysisBusy={analysisBusy} formBusy={formBusy} onAction={technicianAction} onExplain={(order) => void explain("", order.entityId)} onReserve={(event, order) => void reservePart(event, order)} onConsume={(order, id) => void consumeReservation(order, id)}/>}
    </>}
  </section>;
}

function TechnicianContent({ view, data, notes, setNotes, actionBusy, analysis, analysisBusy, formBusy, onAction, onExplain, onReserve, onConsume }: { view: AppView; data: Data; notes: Record<string, string>; setNotes: (update: (current: Record<string, string>) => Record<string, string>) => void; actionBusy: string | null; analysis: Record<string, Analysis>; analysisBusy: string | null; formBusy: boolean; onAction: (order: TechnicianWorkOrder, action: "start" | "block" | "complete") => void; onExplain: (order: TechnicianWorkOrder) => void; onReserve: (event: FormEvent<HTMLFormElement>, order: TechnicianWorkOrder) => void; onConsume: (order: TechnicianWorkOrder, reservationId: string) => void }) {
  const orders = data.myOrders?.items ?? [];
  const uniqueMachines = [...new Map(orders.map((order) => [order.machineId, order.machine])).entries()];
  if (view === "myPanel") return <><div className="module-metrics"><Metric label="Trabajos asignados" value={String(orders.length)}/><Metric label="En curso" value={String(orders.filter((order) => order.status === "in_progress").length)}/><Metric label="Pendientes de aprobación" value={String(orders.filter((order) => order.status === "completed").length)}/></div><div className="module-subheading"><h3>{data.profile?.displayName ?? "Técnico"}</h3><span>{data.profile?.specialties.join(" · ")}</span></div><OrderCards orders={orders.slice(0, 5)} notes={notes} setNotes={setNotes} actionBusy={actionBusy} analysis={analysis} analysisBusy={analysisBusy} formBusy={formBusy} onAction={onAction} onExplain={onExplain} onReserve={onReserve} onConsume={onConsume}/></>;
  if (view === "myMachines") return <div className="machine-assignment-grid">{uniqueMachines.map(([machineId, machine]) => <article className="module-metric" key={machineId}><span>MÁQUINA · {machineId}</span><b>{machine?.model ?? "Equipo registrado"}</b><small>{machine?.category ?? "Categoría no disponible"} · {machine?.location ?? "Ubicación no registrada"}</small><span>{orders.filter((order) => order.machineId === machineId).length} orden(es) asignada(s)</span></article>)}{!uniqueMachines.length && <Empty text="No hay máquinas asociadas a tus trabajos."/>}</div>;
  if (view === "myParts") return <OrderCards orders={orders} partsOnly notes={notes} setNotes={setNotes} actionBusy={actionBusy} analysis={analysis} analysisBusy={analysisBusy} formBusy={formBusy} onAction={onAction} onExplain={onExplain} onReserve={onReserve} onConsume={onConsume}/>;
  if (view === "myHistory") return <div className="module-timeline">{orders.flatMap((order) => (Array.isArray(order.history) ? order.history as Array<Record<string, unknown>> : []).map((event, index) => ({ order, event, index }))).sort((a, b) => String(b.event.at).localeCompare(String(a.event.at))).map(({ order, event, index }) => <article key={`${order.entityId}-${index}`}><span className="timeline-mark"><Clock3 size={12}/></span><div><b>{String(event.status ?? "Cambio de orden")}</b><p>{order.entityId} · {order.machineId}</p><small>{dateLabel(String(event.at ?? order.updatedAt))}{event.notes ? ` · ${String(event.notes)}` : ""}</small></div><span className="timeline-status">Auditoría</span></article>)}{!orders.some((order) => Array.isArray(order.history) && order.history.length) && <Empty text="Todavía no hay cambios de estado en tus órdenes."/>}</div>;
  return <OrderCards orders={orders} notes={notes} setNotes={setNotes} actionBusy={actionBusy} analysis={analysis} analysisBusy={analysisBusy} formBusy={formBusy} onAction={onAction} onExplain={onExplain} onReserve={onReserve} onConsume={onConsume}/>;
}

function OrderCards({ orders, notes, setNotes, actionBusy, analysis, analysisBusy, formBusy, onAction, onExplain, onReserve, onConsume, partsOnly = false }: { orders: TechnicianWorkOrder[]; notes: Record<string, string>; setNotes: (update: (current: Record<string, string>) => Record<string, string>) => void; actionBusy: string | null; analysis: Record<string, Analysis>; analysisBusy: string | null; formBusy: boolean; onAction: (order: TechnicianWorkOrder, action: "start" | "block" | "complete") => void; onExplain: (order: TechnicianWorkOrder) => void; onReserve: (event: FormEvent<HTMLFormElement>, order: TechnicianWorkOrder) => void; onConsume: (order: TechnicianWorkOrder, reservationId: string) => void; partsOnly?: boolean }) {
  return <div className="technician-orders">{orders.filter((order) => !partsOnly || Boolean(order.reservations?.length || order.partsUsed?.length)).map((order) => <article className="technician-order-card" key={order.entityId}><header><div><span className="module-kicker">ORDEN {order.entityId}</span><h3>{order.machine?.model ?? order.machineId}</h3></div><Pill value={String(order.status ?? "unknown")}/></header><p><b>Incidente:</b> {String(order.incident?.title ?? order.incidentId)} · <b>Prioridad:</b> {String(order.priority ?? "—")}</p><p>{String(order.incident?.cause ?? order.incident?.description ?? "Diagnóstico no registrado")}</p><div className="module-order-meta"><span>Asignada {dateLabel(order.updatedAt)}</span><span>{order.machine?.location ?? "Ubicación no registrada"}</span></div><button className="module-link" onClick={() => onExplain(order)} disabled={analysisBusy === order.entityId}>{analysisBusy === order.entityId ? "Consultando inteligencia…" : analysis[order.entityId] ? `Origen: ${analysis[order.entityId].source}` : "Consultar análisis de este trabajo"}</button>{analysis[order.entityId] && <AnalysisCard analysis={analysis[order.entityId]} title="Análisis para este trabajo"/>}
      {(order.status === "planned" || order.status === "assigned" || order.status === "blocked") && <button className="module-primary" onClick={() => onAction(order, "start")} disabled={actionBusy === order.entityId}>Iniciar trabajo</button>}
      {order.status === "in_progress" && <><label className="module-search">Observaciones<input value={notes[order.entityId] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [order.entityId]: event.target.value }))} placeholder="Diagnóstico o acción realizada"/></label><div className="module-action-row"><button onClick={() => onAction(order, "block")} disabled={actionBusy === order.entityId}>Bloquear con nota</button><button className="module-primary" onClick={() => onAction(order, "complete")} disabled={actionBusy === order.entityId}>Enviar a aprobación</button></div></>}
      {!!order.reservations?.length && <div className="module-reservations"><b>Reservas activas</b>{order.reservations.map((reservation) => <div key={String(reservation.reservationId)}><span>{String(reservation.partId)} · {String(reservation.quantity)} {String(reservation.locationId)}</span><button onClick={() => onConsume(order, String(reservation.reservationId))} disabled={actionBusy === reservation.reservationId || !["in_progress", "blocked"].includes(String(order.status))}>Registrar consumo</button></div>)}</div>}
      {order.status !== "completed" && order.status !== "approved" && <details className="module-part-request"><summary>Solicitar reserva de repuesto</summary><form className="module-form-grid" onSubmit={(event) => onReserve(event, order)}><Field label="ID repuesto" name="partId" required/><Field label="Ubicación" name="locationId" required/><Field label="Cantidad" name="quantity" type="number" required/><Field label="Motivo" name="reason" required/><button className="module-primary" disabled={formBusy}>Reservar para esta orden</button></form></details>}
      {(order.partsUsed?.length ?? 0) > 0 && <small>Consumidos: {order.partsUsed?.map((part) => `${part.partId} × ${part.quantity}`).join(" · ")}</small>}</article>)}{!orders.length || partsOnly && !orders.some((order) => order.reservations?.length || order.partsUsed?.length) ? <Empty text={partsOnly ? "No hay repuestos solicitados o consumidos en tus trabajos." : "No tienes trabajos asignados."}/> : null}</div>;
}

function Field({ label, value, onChange, name, type = "text", required = false, disabled = false }: { label: string; value?: string; onChange?: (value: string) => void; name?: string; type?: string; required?: boolean; disabled?: boolean }) { return <label>{label}<input name={name} type={type} value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} required={required} disabled={disabled} min={type === "number" ? "0" : undefined}/></label>; }
function Metric({ label, value, tone = "", title }: { label: string; value: string; tone?: string; title?: string }) { return <article className={`module-metric ${tone}`}><span title={title}>{label}</span><b>{value}</b></article>; }
function Empty({ text }: { text: string }) { return <div className="module-empty"><Circle size={18}/><p>{text}</p></div>; }
function Pill({ value }: { value: string }) { const labels: Record<string, string> = { open: "Abierto", analyzing: "Analizando", pending_assignment: "Pendiente de asignación", acknowledged: "Atendido", assigned: "Asignado", in_progress: "En progreso", resolved: "Resuelto", closed: "Cerrado", planned: "Planificado", blocked: "Bloqueado", completed: "Pendiente de aprobación", approved: "Aprobado", cancelled: "Cancelado", proposed: "Propuesto", accepted: "Aceptado", escalated: "Escalado", unassigned: "Sin asignar", available: "Disponible", unavailable: "No disponible" }; return <span className={`module-pill ${value}`}>{labels[value] ?? value}</span>; }
function AnalysisCard({ analysis, title }: { analysis: Analysis; title: string }) { return <article className="module-analysis"><h3><Sparkles size={15}/>{title}</h3><p>Análisis generado con <b>{analysis.source === "gemini-api" ? "Gemini" : "reglas del sistema"}</b>.</p>{analysis.recommendations.map((item, index) => <div key={index}><b>{item.title}</b><p>{item.reason}</p><small>{item.suggestedAction}</small></div>)}{!analysis.recommendations.length && <p>No hay recomendaciones adicionales; revisa el diagnóstico registrado.</p>}{analysis.evidence && <small>Evidencia asociada al análisis.</small>}</article>; }
function dateLabel(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }) : "—"; }
function WorkflowCard({ assignment, onOpenIncidents }: { assignment: AuraAssignment; onOpenIncidents: () => void }) { const steps = ["proposed", "accepted", "in_progress", "completed_pending_approval", "closed"], current = steps.indexOf(assignment.status), failed = ["escalated", "unassigned"].includes(assignment.status); return <article className="workflow-card"><div className="workflow-card-head"><div><span className="module-kicker">INCIDENTE {assignment.incidentId}</span><h3>{assignment.machineId}</h3></div><Pill value={assignment.status}/></div><div className="workflow-steps" aria-label={`Estado del proceso: ${assignment.status}`}>{["Propuesta", "Confirmación", "Intervención", "Revisión", "Cierre"].map((label, index) => <div key={label} className={index < current ? "step-done" : index === current ? "step-active" : ""}><span>{index < current ? <Check size={12}/> : index + 1}</span><small>{label}</small></div>)}</div><div className="workflow-card-foot"><span>Técnico: {assignment.technicianId ?? "Sin asignar"}</span><span>Costo {Number(assignment.cost).toFixed(3)}{assignment.distanceKm === undefined ? " · distancia omitida" : ` · ${assignment.distanceKm.toFixed(1)} km`}</span>{failed && <button onClick={onOpenIncidents}>Revisar incidente <ArrowRight size={13}/></button>}</div><div className="assignment-cost-factors">{Object.entries(assignment.costBreakdown ?? {}).map(([factor, value]) => <span key={factor}>{factor}: {Number(value).toFixed(2)}</span>)}</div></article>; }
function Timeline({ items }: { items: OperationalItem[] }) { return <div className="module-timeline">{items.map((item) => <article key={item.entityId}><span className="timeline-mark"><Clock3 size={12}/></span><div><b>{toEventLabel(String(item.eventType ?? item.entityId))}</b><p>{String(item.resourceId ?? item.machineId ?? "Evento operativo")}</p><small>{dateLabel(String(item.timestamp ?? item.createdAt))}</small></div><span className="timeline-status">Registrado</span></article>)}{!items.length && <Empty text="No hay eventos AURA registrados."/>}</div>; }
