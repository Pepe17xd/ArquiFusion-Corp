const eventWords: Array<[RegExp, string]> = [
  [/workflow/gi, "proceso"], [/work\s?order/gi, "orden de mantenimiento"], [/work/gi, "trabajo"],
  [/maintenance/gi, "mantenimiento"], [/incident/gi, "incidente"],
  [/anomaly/gi, "anomalía"], [/assignment/gi, "asignación"],
  [/inventory/gi, "inventario"], [/created/gi, "creado"],
  [/completed/gi, "completado"], [/approved/gi, "aprobado"],
  [/assigned/gi, "asignado"], [/started/gi, "iniciado"], [/detected/gi, "detectado"], [/failed/gi, "con error"],
];

/** Turns event codes into readable labels without exposing internal naming conventions. */
export function toEventLabel(value: string): string {
  const knownLabels: Record<string, string> = {
    AgentTaskRequested: "Análisis solicitado",
    AgentTaskStarted: "Análisis iniciado",
    AgentTaskCompleted: "Análisis completado",
    MaintenanceWorkCompleted: "Mantenimiento completado",
  };
  if (knownLabels[value]) return knownLabels[value];
  return eventWords.reduce((label, [pattern, replacement]) => label.replace(pattern, replacement), value.replace(/([a-záéíóúñ])([A-Z])/g, "$1 $2"))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    open: "Abierto", pending: "Pendiente", running: "En curso", completed: "Completado",
    failed: "Con error", succeeded: "Completado", assigned: "Asignado", in_progress: "En progreso",
    resolved: "Resuelto", closed: "Cerrado", acknowledged: "Atendido",
  };
  return labels[value.toLowerCase()] ?? value.replace(/[_-]+/g, " ");
}
