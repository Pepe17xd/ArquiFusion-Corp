const stage = process.env.AURA_DEMO_STAGE;
const base = process.env.AURA_DEMO_API_URL?.replace(/\/$/, "");
const token = process.env.AURA_DEMO_ADMIN_ACCESS_TOKEN;
const tenantId = process.env.AURA_DEMO_TENANT_ID;
const email1 = process.env.AURA_DEMO_TECH1_EMAIL;
const email2 = process.env.AURA_DEMO_TECH2_EMAIL;
if (stage !== "dev" || !base || !token || !tenantId || !email1 || !email2 || !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/dev$/.test(base)) {
  throw new Error("Demo is dev-only. Set AURA_DEMO_STAGE=dev, AURA_DEMO_API_URL=https://<api>.execute-api.<region>.amazonaws.com/dev, AURA_DEMO_TENANT_ID, AURA_DEMO_ADMIN_ACCESS_TOKEN and both technician email variables.");
}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path, { method = "GET", body, key } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(envelope.data ?? envelope)}`);
  return envelope.data;
}
const tenantPath = encodeURIComponent(tenantId);
const now = new Date().toISOString();
const machines = [
  { machineId: "DEMO-EXC-001", model: "Demo Excavator 320", category: "Excavator", location: "DEMO · North yard", status: "operational" },
  { machineId: "DEMO-LOD-002", model: "Demo Wheel Loader 950", category: "Loader", location: "DEMO · South yard", status: "operational" },
  { machineId: "DEMO-DOZ-003", model: "Demo Dozer D6", category: "Dozer", location: "DEMO · East yard", status: "operational" },
];
await api("/ingest/json", { method: "POST", body: machines });
const shifts = [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "23:59", timeZone: "UTC" }];
const techProfiles = [
  { technicianId: "DEMO-TECH-001", displayName: "DEMO Technician One", email: email1, specialties: ["hydraulics", "excavator"], skills: [{ code: "hydraulic-diagnostics", level: 4 }], availability: "available", maxConcurrentAssignments: 2, shifts },
  { technicianId: "DEMO-TECH-002", displayName: "DEMO Technician Two", email: email2, specialties: ["mechanical", "loader"], skills: [{ code: "mechanical-diagnostics", level: 3 }], availability: "available", maxConcurrentAssignments: 2, shifts },
];
for (const profile of techProfiles) await api(`/tenants/${tenantPath}/technicians/invitations`, { method: "POST", body: profile, key: `demo-invite-${profile.technicianId.toLowerCase()}` });
const existingParts = await api("/inventory/parts?limit=100");
const parts = [
  { partId: "DEMO-HYD-FILTER", name: "DEMO Hydraulic filter", sku: "DEMO-HF-001", unit: "each", minimumStock: 2 },
  { partId: "DEMO-SEAL-KIT", name: "DEMO Seal kit", sku: "DEMO-SK-002", unit: "kit", minimumStock: 1 },
];
for (const part of parts) if (!existingParts.items.some((item) => item.partId === part.partId)) await api("/inventory/parts", { method: "POST", body: part });
for (let index = 0; index < parts.length; index += 1) {
  const movementKey = `demo-stock-${parts[index].partId.toLowerCase()}`;
  await api("/inventory/movements", { method: "POST", key: movementKey, body: { partId: parts[index].partId, locationId: "DEMO-NORTH-YARD", quantity: index === 0 ? 8 : 4, kind: "receipt", reason: "DEMO seed stock" } });
}
const incidentResult = await api("/incidents", { method: "POST", key: "demo-enterprise-incident-v1", body: { machineId: machines[0].machineId, type: "DEMO hydraulic inspection", severity: "warning", description: `DEMO record created at ${now}; verify hydraulic leak during inspection.` } });
const incident = incidentResult.incident;
await api(`/incidents/${encodeURIComponent(incident.entityId)}/maintenance-orders`, { method: "POST" });
const recommendation = await api("/assignments/optimize", { method: "POST", key: "demo-enterprise-aura-v1", body: { incidentIds: [incident.entityId], dispatch: false } });
process.stdout.write(JSON.stringify({ label: "DEMO — no production data", tenantId, machines: machines.map((machine) => machine.machineId), technicianInvitations: techProfiles.map((profile) => ({ technicianId: profile.technicianId, email: profile.email })), parts: parts.map((part) => part.partId), incidentId: incident.entityId, workOrderId: (await api("/maintenance/orders?limit=100")).items.find((order) => order.incidentId === incident.entityId)?.entityId ?? null, auraAssignments: recommendation.assignments, next: "Admin: review the persisted proposal and approve a technician in Orchestration. Technicians: complete Cognito invite, sign in, then use My Assignments. No workflow was dispatched by this seed script." }, null, 2) + "\n");
