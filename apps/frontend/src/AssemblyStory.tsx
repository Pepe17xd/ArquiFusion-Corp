import { Activity, Database, GitBranch } from "lucide-react";
import "./story.css";

export function AssemblyStory() {
  return <section className="landing-section problem-section" id="construccion" aria-labelledby="problem-title">
    <div className="problem-copy"><span className="section-index">01 / EL DESAFÍO</span><h2 id="problem-title"><span className="title-fragment">Los datos existen.</span><br/><em className="title-fragment title-fragment-two">El contexto está disperso.</em></h2><p>Archivos, señales y tareas aisladas dificultan entender el estado de la flota. Conectar esa información es el primer paso para actuar con contexto.</p><a href="#solucion" className="text-link">Descubrir la solución <span aria-hidden="true">→</span></a></div>
    <div className="problem-visual" aria-label="Representación de fuentes operativas dispersas"><div className="problem-photo"/><div className="problem-line line-one"/><div className="problem-line line-two"/><div className="problem-fragment fragment-data"><Database/><span>ARCHIVOS<br/><b>CSV / JSON</b></span></div><div className="problem-fragment fragment-signals"><Activity/><span>SEÑALES<br/><b>FLOTA</b></span></div><div className="problem-fragment fragment-tasks"><GitBranch/><span>PROCESOS<br/><b>TAREAS</b></span></div></div>
  </section>;
}
