import { Activity, Droplets, Gauge, Thermometer, Vibrate } from "lucide-react";
import type { Machine } from "../../services/api/client";
import { Skeleton } from "../feedback/FeedbackBanner";

interface Signal { key: keyof Machine; label: string; icon: typeof Activity; unit: string }
const signals: Signal[] = [
  { key: "temperature", label: "Temperatura", icon: Thermometer, unit: "UNIDAD DE ORIGEN" },
  { key: "vibration", label: "Vibración", icon: Vibrate, unit: "UNIDAD DE ORIGEN" },
  { key: "pressure", label: "Presión", icon: Gauge, unit: "UNIDAD DE ORIGEN" },
  { key: "fuelConsumption", label: "Consumo de combustible", icon: Droplets, unit: "UNIDAD DE ORIGEN" },
  { key: "operatingHours", label: "Horas de operación", icon: Activity, unit: "HORAS" },
];

export function TelemetryPanel({ machines, total, loading }: { machines: Machine[]; total: number; loading: boolean }) {
  const observations = signals.map((signal) => {
    const values = machines.map((machine) => machine[signal.key]).filter((value): value is number => typeof value === "number");
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
    return { ...signal, average, observed: values.length };
  });
  return (
    <section className="panel telemetry-panel">
      <div className="panel-heading">
        <div><div className="eyebrow">TELEMETRÍA / LECTURAS ACTUALES</div><h2>Resumen de señales</h2><p>Promedio de los registros cargados · no hay series históricas</p></div>
        <span className="sample-label">{machines.length} / {total} cargadas</span>
      </div>
      {loading ? <div className="telemetry-grid">{signals.map((signal) => <div className="telemetry-card" key={signal.key}><Skeleton className="skeleton-number"/></div>)}</div>
        : <div className="telemetry-grid">{observations.map(({ key, label, icon: Icon, unit, average, observed }) => (
          <article className={"telemetry-card" + (observed === 0 ? " no-reading" : "")} key={key} title={observed ? label + ": promedio de " + observed + " registros" : "No se informó un valor para esta señal"}>
            <div className="telemetry-card-top"><span className="telemetry-icon"><Icon size={15}/></span><span className="telemetry-coverage">{observed}/{machines.length}</span></div>
            <div className="telemetry-reading">{average === undefined ? "—" : average.toLocaleString("en-US", { maximumFractionDigits: 1 })}<small>{average === undefined ? "" : unit}</small></div>
            <div className="telemetry-name">{label}</div>
            <div className="coverage-track" role="img" aria-label={observed + " de " + machines.length + " registros contienen " + label}><i style={{ width: machines.length ? ((observed / machines.length) * 100) + "%" : "0%" }}/></div>
          </article>
        ))}</div>}
      <div className="telemetry-footnote"><span className="info-glyph">i</span> Los registros de origen no especifican unidades de telemetría. La cobertura indica registros con valor, no el estado del sensor.</div>
    </section>
  );
}
