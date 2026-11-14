import { useEffect, useRef } from "react";
import { Activity, ArrowRight, Database, Layers3, LockKeyhole, Network, ShieldCheck } from "lucide-react";
import { ArtificialBrain } from "./components/agents/MascotMark";
import "./landing.css";
import { AssemblyStory } from "./AssemblyStory";
import "./assembly-progress.css";

const capabilities = [
  { Icon: Database, title: "Datos con contexto", description: "Ingesta CSV y JSON, normalización y consulta de maquinaria por organización.", view: "ingestion" },
  { Icon: Activity, title: "Visibilidad de flota", description: "Explora registros, estados y métricas disponibles desde la API.", view: "fleet" },
  { Icon: Network, title: "Orquestación trazable", description: "Consulta tareas y resultados del workflow de recomendaciones existente.", view: "agents" },
];
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const elements = [...container.querySelectorAll<HTMLElement>(".landing-hero, .landing-section")];
    const maximum = elements.map(() => 0);
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const range = (p: number, start: number, end: number) => clamp((p - start) / (end - start));
    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      container.style.setProperty("--progress", `${scrollable > 0 ? window.scrollY / scrollable * 100 : 0}%`);
      container.classList.toggle("is-scrolled", window.scrollY > 40);
      if (!reduced.matches) container.style.setProperty("--hero-shift", `${Math.min(window.scrollY * 0.12, 90)}px`);
      elements.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        const current = clamp((window.innerHeight - rect.top) / (window.innerHeight + rect.height * .3));
        maximum[index] = Math.max(maximum[index], current);
        const p = reduced.matches ? 1 : maximum[index];
        el.style.setProperty("--build", String(p));
        el.style.setProperty("--photo", String(range(p, 0, .35)));
        el.style.setProperty("--title", String(range(p, .1, .45)));
        el.style.setProperty("--primary", String(range(p, .3, .6)));
        el.style.setProperty("--connections", String(range(p, .5, .8)));
        el.style.setProperty("--details", String(range(p, .7, 1)));
      });
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", onScroll, { passive: true }); update();
    window.addEventListener("resize", onScroll); reduced.addEventListener("change", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); reduced.removeEventListener("change", onScroll); cancelAnimationFrame(frame); };
  }, []);
  return <div className="landing" ref={root}><div className="reading-progress" aria-hidden="true"/>
    <header className="landing-nav"><a className="landing-brand" href="/"><img src="/arquifusion-mark.svg" alt=""/> ARQUIFUSION</a><nav aria-label="Navegación principal"><a href="#plataforma">Plataforma</a><a href="#solucion">Solución</a><a href="#arquitectura">Arquitectura</a><a href="#equipo">Equipo</a></nav><div className="nav-actions"><a href="/app">Iniciar sesión</a><a className="landing-button small" href="/app">Comenzar <ArrowRight size={15}/></a></div></header>
    <main><section className="landing-hero"><div className="hero-photo" aria-hidden="true"/><div className="hero-grid" aria-hidden="true"/><div className="telemetry-lines" aria-hidden="true"/><div className="hero-logo-fragments" aria-hidden="true"><img src="/arquifusion-mark.svg" alt=""/><img src="/arquifusion-mark.svg" alt=""/><img src="/arquifusion-mark.svg" alt=""/></div><div className="hero-content"><span className="landing-eyebrow"><span/> INTELIGENCIA OPERACIONAL / ARQUIFUSION</span><h1>El futuro de la operación industrial <em>se construye aquí.</em></h1><p>Inteligencia operativa para maquinaria pesada. Datos, automatización y decisiones en una sola plataforma.</p><div className="hero-actions"><a className="landing-button" href="#plataforma">Explorar plataforma <ArrowRight size={17}/></a><a className="landing-outline" href="/app">Comenzar ahora</a></div></div><div className="hero-foot"><span>OPERACIONES MÁS CLARAS</span><span>01 / CENTRO DE CONTROL</span><span>DESLIZA PARA EXPLORAR ↓</span></div></section>
    <AssemblyStory/>
    <section id="plataforma" className="landing-section intro-section"><div><span className="section-index">01 / PLATAFORMA</span><h2>Una visión conectada<br/><em>de la operación.</em></h2></div><div><p className="section-lead">ArquiFusion reúne datos de maquinaria y flujos de trabajo en un centro de operaciones diseñado para convertir información dispersa en contexto útil.</p><p>Desde la ingesta hasta las recomendaciones, cada paso conserva una relación clara con los datos disponibles.</p></div></section>
    <section id="solucion" className="landing-section"><span className="section-index">02 / CAPACIDADES</span><div className="section-heading"><h2>Del dato a la decisión.</h2><p>Herramientas para entender la flota y dar seguimiento a la actividad.</p></div><div className="capability-grid">{capabilities.map(({Icon,title,description,view}, index) => <article className="capability-card" key={title} onPointerMove={event => { if (event.pointerType !== "mouse") return; const box = event.currentTarget.getBoundingClientRect(); event.currentTarget.style.setProperty("--x", `${event.clientX - box.left}px`); event.currentTarget.style.setProperty("--y", `${event.clientY - box.top}px`); }}><div className="capability-visual" aria-hidden="true"><Icon size={35}/><i/><i/><i/></div><span className="capability-index">0{index + 1} / CAPACIDAD</span><h3>{title}</h3><p>{description}</p><a href={`/app#${view}`}>Explorar capacidad <ArrowRight size={14}/></a></article>)}</div></section>
    <section className="landing-section preview-section"><div><span className="section-index">03 / CENTRO DE OPERACIONES</span><h2>Contexto para actuar<br/><em>con confianza.</em></h2><p className="section-lead">Consulta la flota, ejecuta el flujo de recomendaciones y revisa la actividad desde una sola interfaz.</p><a className="text-link" href="/app">Abrir centro de operaciones <ArrowRight size={16}/></a></div><div className="preview-panel product-assembly" aria-label="Representación ilustrativa del centro de mando, sin datos"><div className="preview-top"><span>ARQUIFUSION / OPERACIONES</span><span>VISTA ILUSTRATIVA</span></div><div className="product-metrics"><div>EQUIPOS <b>—</b></div><div>OPERATIVOS <b>—</b></div><div>ATENCIÓN <b>—</b></div></div><div className="product-modules"><div className="product-brain"><span>NÚCLEO DE INTELIGENCIA</span><ArtificialBrain/><small>WORKFLOW DETERMINISTA</small></div><div className="product-side"><div>FLOTA <i/></div><div>ACTIVIDAD <i/></div><div>RESULTADOS <i/></div></div><svg className="product-links" viewBox="0 0 400 160" preserveAspectRatio="none" aria-hidden="true"><path d="M220 80H300 M300 25V135 M300 25H390 M300 80H390 M300 135H390"/></svg></div><div className="preview-bottom"><span>DATOS</span><span>AUTOMATIZACIÓN</span><span>DECISIONES</span></div></div></section>
    <section id="arquitectura" className="landing-section architecture"><span className="section-index">04 / ARQUITECTURA</span><div className="section-heading"><h2>Diseñada para conectar.</h2><p>Una arquitectura distribuida con límites claros entre datos, identidad y servicios.</p></div><div className="flow"><div><Database/><b>CSV / JSON</b><small>Origen de datos</small></div><div><Layers3/><b>AWS</b><small>API, identidad y orquestación</small></div><div><Network/><b>Google Cloud</b><small>Inteligencia · evolución planificada</small></div><div><ShieldCheck/><b>Cloudflare</b><small>Entrega del frontend</small></div></div><div className="security"><LockKeyhole/><div><h3>Organizaciones aisladas</h3><p>La selección de organización delimita el acceso a flota, archivos y tareas. La autenticación se gestiona con Cognito cuando está configurado.</p></div></div></section>
    <section id="equipo" className="landing-section"><span className="section-index">05 / EQUIPO</span><div className="section-heading"><h2>Detrás de ArquiFusion.</h2><p>Las personas que construyen una nueva perspectiva para la operación industrial.</p></div><div className="team-grid">{[{name:"Antony Rosales", image:"mountains.webp", alt:"Cordillera de montañas"}, {name:"Jose Huaman", image:"forest.webp", alt:"Bosque y lago"}, {name:"Marcelo Dias", image:"desert.webp", alt:"Carretera en un paisaje desértico"}].map((person, i) => <article key={person.name} style={{ transitionDelay: `${i * 100}ms` }}><div className="team-landscape"><img src={`/team/${person.image}`} alt={person.alt} loading="lazy"/><div className="team-overlay"><span>0{i + 1} / EQUIPO</span><h3>{person.name}</h3></div></div></article>)}</div></section>
    <section className="landing-section final-cta"><span className="section-index">EL SIGUIENTE PASO</span><h2>La operación cambia<br/><em>cuando conectas los datos.</em></h2><a className="landing-button" href="/app">Comenzar ahora <ArrowRight size={17}/></a></section></main><footer className="landing-footer"><a className="landing-brand" href="/"><img src="/arquifusion-mark.svg" alt=""/> ARQUIFUSION</a><span>INTELIGENCIA OPERACIONAL PARA MAQUINARIA PESADA</span><span>© ARQUIFUSION</span></footer>
  </div>;
}
