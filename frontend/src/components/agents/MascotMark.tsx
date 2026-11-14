import type { SVGProps } from "react";

export type AgentRole = "coordinator" | "maintenance" | "fleet" | "inventory" | "technicians" | "incidents";

const accents: Record<AgentRole, string> = {
  coordinator: "#91dce5", maintenance: "#f2b96f", fleet: "#9db9ef",
  inventory: "#9fd2a5", technicians: "#c4a3e4", incidents: "#ed8980",
};

export function MascotMark({ role, ...props }: SVGProps<SVGSVGElement> & { role: AgentRole }) {
  const color = accents[role];
  return <svg viewBox="0 0 52 52" fill="none" aria-hidden="true" {...props}>
    <circle cx="26" cy="26" r="23" fill="#0d171b" stroke={color} strokeOpacity=".38"/>
    {role === "coordinator" && <g stroke={color} strokeWidth="1.6"><path d="M26 13v11m0 4v11M13 26h11m4 0h11"/><circle cx="26" cy="26" r="7" fill="#17272c"/><circle cx="26" cy="14" r="2.5" fill={color}/><circle cx="38" cy="26" r="2.5" fill={color}/><circle cx="26" cy="38" r="2.5" fill={color}/><circle cx="14" cy="26" r="2.5" fill={color}/><circle cx="26" cy="26" r="2" fill={color}/></g>}
    {role === "maintenance" && <g stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M27 13a10 10 0 0 0-9 14L14 31v7h7l4-4a10 10 0 0 0 14-9l-7 5-6-6 5-7a10 10 0 0 0-4-4Z"/><circle cx="20" cy="37" r="1.5" fill={color}/></g>}
    {role === "fleet" && <g stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 34h27l-3-12H19l-6 12Z"/><path d="M20 22v-7h11l5 7M17 34a4 4 0 1 0 8 0m7 0a4 4 0 1 0 8 0"/><path d="M15 39h26"/></g>}
    {role === "inventory" && <g stroke={color} strokeWidth="1.7" strokeLinejoin="round"><path d="m26 12 14 8v14l-14 8-14-8V20l14-8Z"/><path d="m12 20 14 8 14-8M26 28v14M19 16l14 8v8l-7 4-7-4v-8l7-4"/><circle cx="26" cy="28" r="2" fill={color}/></g>}
    {role === "technicians" && <g stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 26a12 12 0 0 1 24 0H14Z"/><path d="M18 26v4h16v-4m-8 4v6m-6 3h12"/><path d="m33 15 3 3-7 7-3-3 7-7Z"/><circle cx="25" cy="23" r="1.5" fill={color}/></g>}
    {role === "incidents" && <g stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M26 12 41 39H11L26 12Z"/><path d="M26 22v8m0 4v.2"/><circle cx="26" cy="34" r="1" fill={color}/><path d="M8 19 5 17m39 2 3-2M8 34l-3 2m39-2 3 2" strokeOpacity=".65"/></g>}
  </svg>;
}

export function ArtificialBrain({ state = "idle" }: { state?: "idle" | "processing" | "complete" | "error" }) {
  return <svg className={`artificial-brain brain-${state}`} viewBox="0 0 400 290" fill="none" role="img" aria-label="Ilustración de un cerebro artificial formado por nodos y circuitos">
    <defs>
      <linearGradient id="brain-shell" x1="62" y1="42" x2="338" y2="254" gradientUnits="userSpaceOnUse"><stop stopColor="#142a31"/><stop offset="1" stopColor="#0c171c"/></linearGradient>
      <radialGradient id="brain-center"><stop stopColor="#7deaf0" stopOpacity=".25"/><stop offset="1" stopColor="#7deaf0" stopOpacity="0"/></radialGradient>
      <filter id="brain-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <ellipse cx="200" cy="150" rx="152" ry="117" fill="url(#brain-center)"/>
    <path className="brain-outline" d="M197 54c-12-16-34-18-49-7-9-8-24-7-32 3-14-2-26 8-26 22-15 4-22 19-17 33-13 10-15 29-3 41-10 13-7 31 6 40-8 17 2 35 18 40-1 17 13 30 30 28 8 15 27 19 41 10 10 13 27 13 36 1m6-211c12-16 34-18 49-7 9-8 24-7 32 3 14-2 26 8 26 22 15 4 22 19 17 33 13 10 15 29 3 41 10 13 7 31-6 40 8 17-2 35-18 40 1 17-13 30-30 28-8 15-27 19-41 10-10 13-27 13-36 1" fill="url(#brain-shell)" stroke="#47717a" strokeWidth="2"/>
    <path className="brain-seam" d="M200 48v198" stroke="#6cabb3" strokeOpacity=".68" strokeWidth="1.5" strokeDasharray="3 5"/>
    <g className="brain-circuits" stroke="#67cbd4" strokeOpacity=".78" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m193 72-24 12-1 19-25 14v22l-20 12v22l20 13v18l24 13 3 18 20 10"/><path d="m207 72 24 12 1 19 25 14v22l20 12v22l-20 13v18l-24 13-3 18-20 10"/>
      <path d="m168 84-20-4-12 11m7 26-21-3m21 25-22 2m22 35-21 7m45-64-4 24 18 12-2 25-18 11 2 20m76-107 21-3m-21 28 22 2m-22 35 21 7m-45-64 4 24-18 12 2 25 18 11-2 20"/>
      <path d="m160 100-18 7m97-7 18 7m-97 91-18 5m97-5 18 5m-61-70 12 13 13-13m-25 46 12-12 13 12"/>
    </g>
    <g className="brain-nodes" filter="url(#brain-glow)">
      <circle cx="169" cy="84" r="4"/><circle cx="144" cy="117" r="4"/><circle cx="123" cy="151" r="3.5"/><circle cx="143" cy="186" r="4"/><circle cx="168" cy="213" r="4"/><circle cx="188" cy="125" r="3.5"/><circle cx="182" cy="174" r="4"/><circle cx="231" cy="84" r="4"/><circle cx="256" cy="117" r="4"/><circle cx="277" cy="151" r="3.5"/><circle cx="257" cy="186" r="4"/><circle cx="232" cy="213" r="4"/><circle cx="212" cy="125" r="3.5"/><circle cx="218" cy="174" r="4"/>
    </g>
    <g className="brain-nodes brain-node-fill"><circle cx="169" cy="84" r="3"/><circle cx="144" cy="117" r="3"/><circle cx="123" cy="151" r="2.5"/><circle cx="143" cy="186" r="3"/><circle cx="168" cy="213" r="3"/><circle cx="188" cy="125" r="2.5"/><circle cx="182" cy="174" r="3"/><circle cx="231" cy="84" r="3"/><circle cx="256" cy="117" r="3"/><circle cx="277" cy="151" r="2.5"/><circle cx="257" cy="186" r="3"/><circle cx="232" cy="213" r="3"/><circle cx="212" cy="125" r="2.5"/><circle cx="218" cy="174" r="3"/></g>
    <circle className="brain-hub" cx="200" cy="150" r="12"/><circle className="brain-hub-core" cx="200" cy="150" r="4"/>
    <path d="M72 69h21M307 69h21M67 225h20m226 0h20" stroke="#3b646c" strokeWidth="1" strokeLinecap="round"/>
  </svg>;
}
