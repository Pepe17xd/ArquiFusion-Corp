import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { apiSession } from "../../services/api/client";
import { authMode, beginLogin, clearTenant, completeLoginCallback, hasSession, selectTenant, selectedTenantId, signOut, type TenantChoice } from "../../services/auth/session";

export function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(authMode === "local");
  const [authenticated, setAuthenticated] = useState(authMode === "local" || hasSession());
  const [tenants, setTenants] = useState<TenantChoice[]>([]);
  const [tenantId, setTenantId] = useState(selectedTenantId());
  const [tenantName, setTenantName] = useState("");
  const [tenantRequestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const configured = Boolean(import.meta.env.VITE_COGNITO_CLIENT_ID && import.meta.env.VITE_COGNITO_DOMAIN);

  if (authMode === "invalid") return <section className="auth-shell"><div className="auth-panel"><span className="auth-kicker">CONFIGURACIÓN</span><h1>Modo de acceso no válido</h1><p>Configura VITE_AUTH_MODE como local o cognito. La aplicación permanecerá cerrada hasta corregirlo.</p></div></section>;

  useEffect(() => {
    if (authMode === "local") return;
    let active = true;
    void (async () => {
      try {
        await completeLoginCallback();
        const signedIn = hasSession();
        if (active) setAuthenticated(signedIn);
        if (signedIn) {
          const choices = await apiSession.tenants();
          if (!active) return;
          setTenants(choices);
          const selected = selectedTenantId();
          if (selected && choices.some((entry) => entry.tenant.tenantId === selected)) setTenantId(selected);
          else if (choices.length === 1) { selectTenant(choices[0].tenant.tenantId); setTenantId(choices[0].tenant.tenantId); }
          else { clearTenant(); setTenantId(undefined); }
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "No se pudo iniciar la sesión."); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const expired = () => { setAuthenticated(false); setTenantId(undefined); setTenants([]); };
    window.addEventListener("arquifusion:session-expired", expired);
    return () => window.removeEventListener("arquifusion:session-expired", expired);
  }, []);

  async function createTenant(event: FormEvent) {
    event.preventDefault(); if (!tenantName.trim()) return;
    setBusy(true); setError("");
    try {
      const created = await apiSession.createTenant(tenantName.trim(), tenantRequestKey);
      const next = [...tenants, created]; setTenants(next); selectTenant(created.tenant.tenantId); setTenantId(created.tenant.tenantId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo crear el espacio de trabajo."); }
    finally { setBusy(false); }
  }

  if (authMode === "local") return <>{children}</>;
  if (!ready) return <section className="auth-shell"><div className="auth-panel" role="status" aria-live="polite"><span className="auth-kicker">ARQUIFUSION / IDENTIDAD</span><h1>Verificando sesión</h1><p>Conectando con la identidad de la organización.</p></div></section>;
  if (!authenticated) return <section className="auth-shell auth-split"><div className="auth-visual"><a href="/" className="auth-visual-brand"><img src="/arquifusion-mark.svg" alt=""/> ARQUIFUSION</a><div><span>INTELIGENCIA OPERACIONAL / ACCESO SEGURO</span><h2>La operación,<br/><em>en perspectiva.</em></h2><p>Datos y decisiones conectados para la maquinaria que mueve el mundo.</p></div><small>ARQUIFUSION / CENTRO DE OPERACIONES</small></div><div className="auth-panel">
    <div className="auth-brand"><img src="/arquifusion-mark.svg" alt=""/><strong>ARQUIFUSION</strong></div>
    <span className="auth-kicker">INTELIGENCIA OPERACIONAL</span><h1>Control con contexto.</h1>
    <p>Un espacio seguro para comprender el estado de su flota y convertir datos operativos en decisiones.</p>
    {error && <div className="auth-error" role="alert">{error}</div>}
    {!configured && <div className="auth-error" role="status">Cognito no está configurado en este frontend. Define las variables VITE_COGNITO_* para habilitar el acceso.</div>}
    <button className="auth-primary" disabled={!configured} onClick={() => { void beginLogin(false).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo iniciar el acceso.")); }}>Iniciar sesión</button>
    <button className="auth-secondary" disabled={!configured} onClick={() => { void beginLogin(true).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "No se pudo abrir el registro.")); }}>Crear una cuenta</button>
    <small>Autenticación gestionada por Amazon Cognito. Las operaciones requieren una membresía verificada.</small>
  </div><div className="auth-ambient" aria-hidden="true"><div className="auth-orbit orbit-a"/><div className="auth-orbit orbit-b"/><div className="auth-core"/></div></section>;
  if (!tenantId) return <section className="auth-shell"><div className="auth-panel">
    <span className="auth-kicker">SELECCIÓN DE ESPACIO</span><h1>Elija su organización</h1><p>La flota, las tareas y los archivos se aíslan por organización.</p>
    {tenants.length > 0 && <div className="tenant-options">{tenants.map((entry) => <button key={entry.tenant.tenantId} onClick={() => { selectTenant(entry.tenant.tenantId); setTenantId(entry.tenant.tenantId); }}><span>{entry.tenant.name}</span><small>Rol: {entry.membership.role}</small></button>)}</div>}
    <form className="tenant-create" onSubmit={createTenant}><label htmlFor="tenant-name">Crear organización</label><input id="tenant-name" value={tenantName} onChange={(event) => setTenantName(event.target.value)} maxLength={120} required placeholder="Nombre de la organización"/><button className="auth-primary" disabled={busy}>{busy ? "Creando…" : "Crear espacio"}</button></form>
    {error && <div className="auth-error" role="alert">{error}</div>}<button className="auth-link" onClick={signOut}>Cerrar sesión</button>
  </div></section>;
  return <>{children}</>;
}
