import { Activity } from "lucide-react";

export function ActivityView() {
  return <section className="panel activity-empty"><span className="activity-emblem"><Activity size={20}/></span><div className="eyebrow">ACTIVIDAD DEL SISTEMA / AUDITORÍA</div><h2>El historial persistente de eventos no está disponible</h2>
    <p>El backend aún no ofrece un endpoint de eventos ni almacenamiento duradero de actividad. Las respuestas de importación y del workflow aparecen solo en sus módulos; esta vista no presenta datos de sesión como un registro de auditoría.</p>
    <div className="activity-schema"><span>FECHA Y HORA</span><span>RESPONSABLE</span><span>ACCIÓN</span><span>RECURSO</span><span>RESULTADO</span><span>ID DE EJECUCIÓN</span></div>
    <small>Contrato futuro: eventos de solo anexado con responsable, acción, recurso, resultado, severidad, duración e identificador de ejecución.</small>
  </section>;
}
