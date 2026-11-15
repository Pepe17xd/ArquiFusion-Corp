import { ArrowRight } from "lucide-react";

export function IndustrialHero() {
  return <section className="landing-hero" aria-labelledby="industrial-hero-title">
    <div className="hero-photo" aria-hidden="true"/>
    <div className="hero-content">
      <span className="landing-eyebrow"><span/> INTELIGENCIA OPERACIONAL / ARQUIFUSION</span>
      <h1 id="industrial-hero-title">Inteligencia que mueve tu <em>industria.</em></h1>
      <p>Supervisa tu flota, anticipa incidentes y coordina operaciones desde una plataforma inteligente.</p>
      <div className="hero-actions"><a className="landing-button" href="#plataforma">Explorar plataforma <ArrowRight size={17}/></a><a className="landing-outline" href="/app">Iniciar sesión</a></div>
    </div>
    <div className="hero-foot"><span>OPERACIONES CON CONTEXTO</span><span>01 / CENTRO DE CONTROL</span><span>DESLIZA PARA EXPLORAR ↓</span></div>
  </section>;
}
