import { HardHat, PackageSearch, ShieldAlert, Wrench } from "lucide-react";
import type { AppView } from "../../components/navigation/NavigationRail";

const plannedModules: Partial<Record<AppView, { title: string; icon: typeof Wrench }>> = {
  maintenance: { title: "Mantenimiento predictivo", icon: Wrench },
  inventory: { title: "Inteligencia de inventario", icon: PackageSearch },
  technicians: { title: "Asignación de técnicos", icon: HardHat },
  incidents: { title: "Centro de incidentes", icon: ShieldAlert },
};

export function PlannedView({ view, description }: { view: AppView; description: string }) {
  const module = plannedModules[view];
  if (!module) return null;
  const Icon = module.icon;
  return <section className="panel planned-module"><span className="planned-module-icon"><Icon size={22}/></span><span className="status-badge planned">PLANIFICADO</span><h2>{module.title}</h2><p>{description}</p><p className="planned-explainer">Este espacio está reservado para el módulo operacional. Se incorporarán controles cuando existan las funciones y los datos correspondientes.</p></section>;
}
