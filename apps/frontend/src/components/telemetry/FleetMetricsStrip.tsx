import { Activity, AlertTriangle, Check, Wrench } from "lucide-react";
import type { FleetMetrics } from "../../services/api/client";
import { Skeleton } from "../feedback/FeedbackBanner";

export function FleetMetricsStrip({ metrics, loading }: { metrics: FleetMetrics | null; loading: boolean }) {
  const items = [
    { label: "Equipos registrados", value: metrics?.total, note: "Total de maquinaria", icon: Activity, accent: "ice" },
    { label: "Operativas", value: metrics?.operational, note: metrics ? metrics.availabilityPercent.toFixed(1) + "% de disponibilidad" : "Estado informado", icon: Check, accent: "cyan" },
    { label: "En mantenimiento", value: metrics?.maintenance, note: "Estado informado", icon: Wrench, accent: "amber" },
    { label: "Requieren atención", value: metrics ? metrics.alert + metrics.stopped : undefined, note: metrics ? metrics.alert + " alertas · " + metrics.stopped + " detenidas" : "Alertas y equipos detenidos", icon: AlertTriangle, accent: "red" },
  ];
  return (
    <section className="metric-strip" aria-label="Indicadores de estado de la flota">
      {items.map(({ label, value, note, icon: Icon, accent }, index) => (
        <article className={"metric-tile accent-" + accent} key={label}>
          <div className="metric-tile-top"><span className="metric-tile-index">0{index + 1}</span><Icon size={16}/></div>
          <div className="metric-label">{label}</div>
          <div className="metric-value">{loading ? <Skeleton className="skeleton-number"/> : value === undefined ? "—" : value.toLocaleString()}</div>
          <div className="metric-note">{note}</div>
        </article>
      ))}
    </section>
  );
}
