import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Machine } from "../core/machine";
import type { IntelligenceInput, IntelligenceOutput, IntelligenceProvider, Recommendation } from "./contracts";

const FleetState = Annotation.Root({
  machines: Annotation<Machine[]>,
  recommendations: Annotation<Recommendation[]>({ reducer: (_current, update) => update, default: () => [] }),
});

function assessFleet(state: typeof FleetState.State) {
  const recommendations: Recommendation[] = [];
  for (const machine of state.machines) {
    if (machine.status === "alert" || machine.status === "stopped") {
      recommendations.push({
        machineId: machine.machineId, priority: "high", category: "maintenance",
        title: machine.status === "alert" ? "Investigar alerta operativa" : "Recuperar máquina detenida",
        reason: `El estado registrado es ${machine.status}.`,
        suggestedAction: "Asignar un técnico para inspección y registrar el resultado antes de reanudar la operación.",
        evidence: { status: machine.status },
      });
    }
    if (machine.temperature !== undefined && machine.temperature >= 90) {
      recommendations.push({
        machineId: machine.machineId, priority: "high", category: "maintenance",
        title: "Revisar temperatura elevada",
        reason: `La temperatura reportada es ${machine.temperature} °C.`,
        suggestedAction: "Inspeccionar refrigeración y validar el sensor; confirmar el umbral con las especificaciones del fabricante.",
        evidence: { temperature: machine.temperature },
      });
    }
    if (machine.vibration !== undefined && machine.vibration >= 5) {
      recommendations.push({
        machineId: machine.machineId, priority: "medium", category: "maintenance",
        title: "Programar inspección de vibración",
        reason: `La vibración reportada es ${machine.vibration}.`,
        suggestedAction: "Comparar con la línea base del modelo y revisar componentes rotativos en la próxima ventana de mantenimiento.",
        evidence: { vibration: machine.vibration },
      });
    }
  }
  return { recommendations };
}

const graph = new StateGraph(FleetState)
  .addNode("assessFleet", assessFleet)
  .addEdge(START, "assessFleet")
  .addEdge("assessFleet", END)
  .compile();

export class LangGraphFleetIntelligence implements IntelligenceProvider {
  async recommend(input: IntelligenceInput): Promise<IntelligenceOutput> {
    const result = await graph.invoke({ machines: input.machines });
    return { generatedAt: new Date().toISOString(), recommendations: result.recommendations, source: "deterministic-rules" };
  }
}
