import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, X } from "lucide-react";
import type { FleetMetrics, Machine, MachineStatus } from "../../services/api/client";
import { FleetMetricsStrip } from "../../components/telemetry/FleetMetricsStrip";
import { paginate } from "./pagination";
import { MachineStatusBadge } from "../../components/ui/StatusBadge";

export function FleetView({ machines, metrics, loading, fleetError, search, setSearch, onSearch, status, setStatus, category, setCategory, appliedSearch, pageNumber, pageSize, setPageNumber, setPageSize, onOpenMachine }: {
  machines: Machine[]; metrics: FleetMetrics | null; loading: boolean; fleetError: boolean; search: string; setSearch: (value: string) => void;
  onSearch: (event: FormEvent) => void; status: string; setStatus: (value: string) => void; category: string;
  setCategory: (value: string) => void; appliedSearch: string; pageNumber: number; pageSize: number;
  setPageNumber: (value: number) => void; setPageSize: (value: number) => void; onOpenMachine: (id: string) => void;
}) {
  const categories = Object.keys(metrics?.byCategory || {});
  const query = appliedSearch.toLocaleLowerCase("es");
  const filtered = machines.filter(machine => (!status || machine.status === status) && (!category || machine.category === category) && (!query || [machine.machineId, machine.model, machine.category, machine.location].some(value => value.toLocaleLowerCase("es").includes(query))));
  const page = paginate(filtered, pageNumber, pageSize);
  return <>
    <FleetMetricsStrip metrics={metrics} loading={loading}/>
    <section className="panel fleet-table-panel">
      <div className="fleet-toolbar">
        <form className="search-form" onSubmit={onSearch}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input aria-label="Buscar por ID, modelo o ubicaci?n" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar ID, modelo o ubicación"/>
          <button type="submit">Buscar</button>
        </form>
        <div className="filters">
          <label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos los estados</option>{(["operational", "maintenance", "stopped", "alert"] as MachineStatus[]).map((value) => <option key={value} value={value}>{({ operational: "Operativa", maintenance: "Mantenimiento", stopped: "Detenida", alert: "Alerta" })[value]}</option>)}</select><ChevronDown size={13}/></label>
          <label><span>Categoría</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas las categorías</option>{categories.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={13}/></label>
        </div>
      </div>
      {fleetError && !loading ? <div className="table-message" role="alert">No se pudieron cargar los registros de flota. Actualiza para reintentar.</div> : <MachineTable machines={page.items} loading={loading} onOpen={onOpenMachine}/>}
      <div className="pagination"><div><span>Paginaci?n del cliente ? {fleetError ? "Total no disponible" : `${page.total} registros coincidentes`} ? p?gina {page.page} de {page.pages} ? {page.items.length} visibles</span><label>Registros por p?gina <select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[5, 10, 20].map(size => <option key={size} value={size}>{size}</option>)}</select></label></div><div>
        <button className="button button-secondary" disabled={page.page <= 1 || loading} onClick={() => setPageNumber(page.page - 1)}><ArrowLeft size={14}/> Anterior</button>
        <button className="button button-secondary" disabled={page.page >= page.pages || loading} onClick={() => setPageNumber(page.page + 1)}>Siguiente <ArrowRight size={14}/></button>
      </div></div>
    </section>
  </>;
}

export function MachineTable({ machines, loading, onOpen, title, action }: {
  machines: Machine[]; loading: boolean; onOpen: (id: string) => void; title?: string; action?: () => void;
}) {
  return <section className="panel fleet-table-panel">
    <div className="section-heading"><div><div className="eyebrow">MAQUINARIA REGISTRADA</div><h2>{title || "Registros de flota"}</h2></div>{action && <button className="text-button" onClick={action}>Ver flota <ArrowRight size={14}/></button>}</div>
    <div className="table-scroll"><table><thead><tr><th>MÁQUINA</th><th>CATEGORÍA</th><th>UBICACIÓN</th><th>ESTADO</th><th>HORAS</th><th>ACTUALIZACIÓN</th></tr></thead>
      <tbody>{machines.map((machine) => <tr key={machine.machineId} tabIndex={0} onClick={() => onOpen(machine.machineId)} onKeyDown={(event) => event.key === "Enter" && onOpen(machine.machineId)}>
        <td><span className="machine-id">{machine.machineId}<small>{machine.model}</small></span></td><td>{machine.category}</td><td>{machine.location}</td><td><MachineStatusBadge status={machine.status}/></td><td>{machine.operatingHours ?? "—"}</td><td>{formatTimestamp(machine.updatedAt, true)}</td>
      </tr>)}</tbody></table>
      {loading && <div className="table-message">Cargando registros de flota…</div>}{!loading && !machines.length && <div className="table-message">Ninguna máquina coincide con esta vista.</div>}
    </div>
  </section>;
}

export function MachineDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const signals: [string, number | undefined, string][] = [["Horas de operación", machine.operatingHours, "h"], ["Temperatura", machine.temperature, "unidad de origen"], ["Vibración", machine.vibration, "unidad de origen"], ["Presión", machine.pressure, "unidad de origen"], ["Consumo de combustible", machine.fuelConsumption, "unidad de origen"]];
  return <div className="dialog-backdrop" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={`Detalles de máquina ${machine.machineId}`} className="panel machine-dialog" onClick={(event) => event.stopPropagation()}>
    <div className="dialog-head"><div><div className="eyebrow">REGISTRO DE MÁQUINA / {(machine.dataSource || "ORIGEN NO INFORMADO").toUpperCase()}</div><h2>{machine.machineId}</h2><p>{machine.model}</p></div><button className="icon-button" onClick={onClose} aria-label="Cerrar detalles"><X size={18}/></button></div>
    <div className="dialog-context"><MachineStatusBadge status={machine.status}/><span>{machine.category}</span><span>{machine.location}</span></div>
    <div className="detail-signals">{signals.map(([label, value, unit]) => <div key={label}><small>{label}</small><b>{value === undefined ? "Sin lectura" : `${value} ${unit}`}</b></div>)}</div>
    <div className="dialog-source">Actualizada {formatTimestamp(machine.updatedAt)} · Registro de origen: {machine.dataSource || "No informado"}</div>
  </section></div>;
}

function formatTimestamp(value?: string, dateOnly = false) {
  if (!value) return "No informado";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No informado" : dateOnly ? date.toLocaleDateString("es-PE") : date.toLocaleString("es-PE");
}
