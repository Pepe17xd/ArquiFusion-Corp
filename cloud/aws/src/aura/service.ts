import { createHash } from "node:crypto";
import type { MachineRepository } from "../storage/contracts";
import type { OperationalRecord, OperationalRepository } from "../operations/contracts";
import { NotFoundError } from "../core/errors";
import { ValidationError } from "../core/machine";
import { AuraConflictError, AuraDispatchError, AuraDuplicateError, AuraStockError, type AuraEntityType, type AuraRecord, type AuraRepository } from "./contracts";
import { solveHungarianAssignment } from "./hungarian-assignment";
import type { Coordinates } from "./validation";

export interface AuraWorkflowDispatcher { dispatch(input: { tenantId: string; assignmentIds: string[] }): Promise<void> }
export interface CallbackTokenSender { succeed(taskToken: string, result: Record<string, unknown>): Promise<void> }
interface AssignmentCandidate { technicianId: string; cost: number; breakdown: Record<string, number>; weights: { skill: number; workload: number; distance: number }; omittedFactors: string[]; distanceKm?: number }

const defaultPolicy = { weights: { skill: 0.45, workload: 0.35, distance: 0.2 }, maxDistanceKm: 250, unmatchedPenalty: { info: 0.6, warning: 0.78, critical: 0.94 } };
const terminalAssignmentStates = new Set(["closed", "escalated", "cancelled"]);

export class AuraService {
  constructor(
    private readonly repository: AuraRepository,
    private readonly operations: OperationalRepository,
    private readonly machines: MachineRepository,
    private readonly workflow?: AuraWorkflowDispatcher,
    private readonly callbacks?: CallbackTokenSender,
  ) {}

  async list(tenantId: string, type: AuraEntityType, limit: number, cursor?: string) { return this.repository.queryByType(tenantId, type, limit, cursor); }
  async get(tenantId: string, type: AuraEntityType, id: string) { return this.repository.get(tenantId, type, id); }

  async inventoryAlerts(tenantId: string, limit = 25, cursor?: string) {
    const [stockPage, parts] = await Promise.all([this.repository.queryByType(tenantId, "STOCK", limit, cursor), this.allByType(tenantId, "PART")]);
    const byId = new Map(parts.map((part) => [String(part.partId), part]));
    const items = stockPage.items.flatMap((record) => {
      const part = byId.get(String(record.partId));
      const available = Number(record.onHand) - Number(record.reserved);
      if (!part || available >= Number(part.minimumStock ?? 0)) return [];
      return [{ partId: record.partId, name: part.name, sku: part.sku, locationId: record.locationId, onHand: record.onHand, reserved: record.reserved, available, minimumStock: part.minimumStock, severity: available <= 0 ? "critical" : "warning", observedAt: record.updatedAt }];
    });
    return { items, nextCursor: stockPage.nextCursor };
  }

  async saveTechnician(tenantId: string, input: Record<string, unknown>, expectedVersion: number | null) {
    const now = new Date().toISOString();
    const current = expectedVersion === null ? undefined : await this.repository.get(tenantId, "TECHNICIAN", String(input.technicianId));
    if (expectedVersion !== null && !current) throw new NotFoundError("Technician not found");
    if (current && current.version !== expectedVersion) throw new AuraConflictError();
    const record: AuraRecord = { ...input, tenantId, entityType: "TECHNICIAN", entityId: String(input.technicianId), createdAt: current?.createdAt ?? now, updatedAt: now, version: (current?.version ?? 0) + 1, status: "active" };
    await this.repository.save(record, current ? Number(current.version) : null);
    return record;
  }

  async archiveTechnician(tenantId: string, technicianId: string, expectedVersion: number) {
    const current = await this.repository.get(tenantId, "TECHNICIAN", technicianId);
    if (!current) throw new NotFoundError("Technician not found");
    if (current.version !== expectedVersion) throw new AuraConflictError();
    const updated = { ...current, status: "inactive", version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    await this.repository.save(updated, expectedVersion);
    return updated;
  }

  async setMachineCoordinates(tenantId: string, machineId: string, coordinates: Coordinates, expectedVersion?: number) {
    if (!await this.machines.get(tenantId, machineId)) throw new NotFoundError("Machine not found");
    const current = await this.repository.get(tenantId, "MACHINE_LOCATION", machineId);
    if (current && current.version !== expectedVersion) throw new AuraConflictError("Machine coordinates changed; supply the current version");
    if (!current && expectedVersion !== undefined) throw new AuraConflictError("Coordinates do not exist; omit If-Match when creating them");
    const now = new Date().toISOString();
    const record: AuraRecord = { tenantId, entityType: "MACHINE_LOCATION", entityId: machineId, machineId, coordinates, verified: true, version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    await this.repository.save(record, current ? Number(current.version) : null);
    return record;
  }

  async createPart(tenantId: string, input: Record<string, unknown>) {
    const now = new Date().toISOString();
    const record: AuraRecord = { ...input, tenantId, entityType: "PART", entityId: String(input.partId), status: "active", version: 1, createdAt: now, updatedAt: now };
    await this.repository.save(record, null);
    return record;
  }

  async applyStockMovement(tenantId: string, input: { partId: string; locationId: string; quantity: number; kind: string; reason: string }, idempotencyKey: string) {
    const requestHash = hash(JSON.stringify(input));
    const movementId = hash(`${tenantId}|stock-movement|${idempotencyKey}`);
    const prior = await this.repository.get(tenantId, "MOVEMENT", movementId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AuraConflictError("idempotency-key was already used with another movement");
      return { movement: prior, replayed: true };
    }
    const part = await this.repository.get(tenantId, "PART", input.partId);
    if (!part || part.status !== "active") throw new NotFoundError("Part not found");
    const stockId = stockIdentity(input.partId, input.locationId);
    const current = await this.repository.get(tenantId, "STOCK", stockId);
    if (!current) {
      if (input.quantity < 0) throw new AuraStockError("Cannot decrement stock before a stock balance exists");
      const now = new Date().toISOString();
      const stock: AuraRecord = { tenantId, entityType: "STOCK", entityId: stockId, stockId, partId: input.partId, locationId: input.locationId, onHand: 0, reserved: 0, version: 1, createdAt: now, updatedAt: now };
      try { await this.repository.save(stock, null); } catch (error) { if (!(error instanceof AuraConflictError)) throw error; }
    }
    const refreshed = await this.repository.get(tenantId, "STOCK", stockId);
    if (!refreshed) throw new AuraConflictError();
    const quantity = Number(input.quantity);
    const nextOnHand = Number(refreshed.onHand) + quantity;
    if (nextOnHand < Number(refreshed.reserved)) throw new AuraStockError("Movement would make available stock negative");
    const now = new Date().toISOString();
    const movement: AuraRecord = { tenantId, entityType: "MOVEMENT", entityId: movementId, movementId, stockId, partId: input.partId, locationId: input.locationId, kind: input.kind, quantity, reason: input.reason, requestHash, createdAt: now, updatedAt: now };
    try {
      const stock = await this.repository.adjustStock({ tenantId, stockId, expectedVersion: Number(refreshed.version), nextOnHand, movement });
      return { movement, stock, replayed: false };
    } catch (error) {
      const raced = await this.repository.get(tenantId, "MOVEMENT", movementId);
      if (raced?.requestHash === requestHash) return { movement: raced, stock: await this.repository.get(tenantId, "STOCK", stockId), replayed: true };
      throw error;
    }
  }

  async reservePart(tenantId: string, workOrderId: string, input: { partId: string; locationId: string; quantity: number; reason: string }, idempotencyKey: string) {
    const workOrder = await this.operations.get(tenantId, "WORK_ORDER", workOrderId);
    if (!workOrder || ["completed", "cancelled"].includes(String(workOrder.status))) throw new NotFoundError("Active maintenance order not found");
    const part = await this.repository.get(tenantId, "PART", input.partId);
    if (!part || part.status !== "active") throw new NotFoundError("Part not found");
    const requestHash = hash(JSON.stringify({ workOrderId, ...input }));
    const idempotencyId = hash(`${tenantId}|reservation-key|${idempotencyKey}`);
    const oldRequest = await this.repository.get(tenantId, "IDEMPOTENCY", idempotencyId);
    if (oldRequest) {
      if (oldRequest.requestHash !== requestHash) throw new AuraConflictError("idempotency-key was already used with another reservation");
      return { reservation: oldRequest.response as AuraRecord, replayed: true };
    }
    const stockId = stockIdentity(input.partId, input.locationId);
    const stock = await this.repository.get(tenantId, "STOCK", stockId);
    if (!stock) throw new AuraStockError("No stock balance exists at this location");
    const now = new Date().toISOString();
    const reservationId = hash(`${tenantId}|reservation|${idempotencyKey}`);
    const reservation: AuraRecord = { tenantId, entityType: "RESERVATION", entityId: reservationId, reservationId, stockId, partId: input.partId, locationId: input.locationId, workOrderId, machineId: workOrder.machineId, quantity: input.quantity, reason: input.reason, status: "active", version: 1, createdAt: now, updatedAt: now, expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 };
    const movement: AuraRecord = { tenantId, entityType: "MOVEMENT", entityId: hash(`${reservationId}|reserve`), stockId, reservationId, workOrderId, partId: input.partId, locationId: input.locationId, kind: "reservation", quantity: -input.quantity, reason: input.reason, createdAt: now, updatedAt: now };
    const ledger: AuraRecord = { tenantId, entityType: "IDEMPOTENCY", entityId: idempotencyId, requestHash, response: reservation, createdAt: now, updatedAt: now, expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 };
    try {
      await this.repository.reserveStock({ tenantId, stockId, expectedVersion: Number(stock.version), quantity: input.quantity, reservation, movement, idempotency: ledger });
      return { reservation, replayed: false };
    } catch (error) {
      const raced = await this.repository.get(tenantId, "IDEMPOTENCY", idempotencyId);
      if (raced?.requestHash === requestHash) return { reservation: raced.response as AuraRecord, replayed: true };
      throw error;
    }
  }

  async settleReservation(tenantId: string, reservationId: string, action: "release" | "consume") {
    const reservation = await this.repository.get(tenantId, "RESERVATION", reservationId);
    if (!reservation) throw new NotFoundError("Reservation not found");
    if (reservation.status !== "active") return { reservation, replayed: true };
    const stock = await this.repository.get(tenantId, "STOCK", String(reservation.stockId));
    if (!stock) throw new AuraConflictError("Stock balance for reservation is unavailable");
    const quantity = Number(reservation.quantity);
    const now = new Date().toISOString();
    const status = action === "consume" ? "consumed" : "released";
    const movement: AuraRecord = { tenantId, entityType: "MOVEMENT", entityId: hash(`${reservationId}|${status}`), stockId: reservation.stockId, reservationId, workOrderId: reservation.workOrderId, partId: reservation.partId, locationId: reservation.locationId, kind: status, quantity: action === "consume" ? -quantity : 0, reason: action === "consume" ? "Consumed by maintenance intervention" : "Released reservation", createdAt: now, updatedAt: now };
    try {
      await this.repository.settleReservation({ tenantId, stockId: String(reservation.stockId), expectedStockVersion: Number(stock.version), reservationId, expectedReservationVersion: Number(reservation.version), quantity, nextOnHand: Number(stock.onHand) - (action === "consume" ? quantity : 0), nextReserved: Number(stock.reserved) - quantity, status, movement });
    } catch (error) {
      const raced = await this.repository.get(tenantId, "RESERVATION", reservationId);
      if (raced?.status === status) return { reservation: raced, replayed: true };
      throw error;
    }
    return { reservation: await this.repository.get(tenantId, "RESERVATION", reservationId), replayed: false };
  }

  async savePolicy(tenantId: string, input: Record<string, unknown>, expectedVersion: number | null) {
    const current = await this.repository.get(tenantId, "POLICY", "active");
    if (expectedVersion === null ? Boolean(current) : !current || current.version !== expectedVersion) throw new AuraConflictError("Assignment policy version changed");
    const now = new Date().toISOString();
    const policy = { tenantId, entityType: "POLICY" as const, entityId: "active", ...input, version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    await this.repository.save(policy, current ? Number(current.version) : null);
    return policy;
  }

  async policy(tenantId: string) {
    const current = await this.repository.get(tenantId, "POLICY", "active");
    return current ?? { tenantId, entityType: "POLICY", entityId: "active", ...defaultPolicy, version: 0, configured: false };
  }

  async optimize(tenantId: string, input: { incidentIds: string[]; requirements: Record<string, Array<{ code: string; minLevel: number }>> }, idempotencyKey: string) {
    const requestHash = hash(JSON.stringify(input));
    const ledgerId = hash(`${tenantId}|assignment-optimization|${idempotencyKey}`);
    const prior = await this.repository.get(tenantId, "IDEMPOTENCY", ledgerId);
    if (prior) return this.replayOptimization(tenantId, prior, requestHash);
    const incidents = await Promise.all(input.incidentIds.map((id) => this.operations.get(tenantId, "INCIDENT", id)));
    if (incidents.some((incident) => !incident || !["open", "acknowledged"].includes(String(incident.status)))) throw new NotFoundError("One or more requested incidents are not open in this organization");
    const workOrders = await this.allByTypeOperations(tenantId, "WORK_ORDER");
    if ((incidents as OperationalRecord[]).some((incident) => !workOrders.some((order) => order.incidentId === incident.entityId && !["completed", "cancelled"].includes(String(order.status))))) throw new ValidationError(["Each coordinated incident must have an active maintenance order"]);
    const allTechnicians = await this.allByType(tenantId, "TECHNICIAN");
    const machineLocations = await this.allByType(tenantId, "MACHINE_LOCATION");
    const allAssignments = await this.allByType(tenantId, "ASSIGNMENT");
    const activeLoad = new Map<string, number>();
    for (const assignment of allAssignments) if (assignment.technicianId && !terminalAssignmentStates.has(String(assignment.status))) activeLoad.set(String(assignment.technicianId), (activeLoad.get(String(assignment.technicianId)) ?? 0) + 1);
    const policyRecord = await this.policy(tenantId);
    const policy = (policyRecord.weights ? policyRecord : defaultPolicy) as typeof defaultPolicy;
    const profiles = allTechnicians.filter((technician) => technician.status === "active").sort((a, b) => String(a.technicianId).localeCompare(String(b.technicianId)));
    const candidatesByIncident: AssignmentCandidate[][] = [];
    const costMatrix: Array<Array<number | null>> = [];
    const unassignedCosts = incidents.map((incident) => policy.unmatchedPenalty[String(incident!.severity) as keyof typeof defaultPolicy.unmatchedPenalty] ?? policy.unmatchedPenalty.warning);
    for (const incident of incidents as OperationalRecord[]) {
      const required = input.requirements[incident.entityId] ?? [];
      const location = machineLocations.find((item) => item.machineId === incident.machineId && item.verified === true)?.coordinates as Coordinates | undefined;
      const candidates: AssignmentCandidate[] = [];
      for (const technician of profiles) {
        const skills = technician.skills as Array<{ code: string; level: number }>;
        const available = technician.availability === "available" && isOnShift(technician.shifts, new Date()) && (activeLoad.get(String(technician.technicianId)) ?? 0) < Number(technician.maxConcurrentAssignments);
        const eligibleSkills = required.every((requirement) => skills.some((skill) => skill.code === requirement.code && skill.level >= requirement.minLevel));
        if (!available || !eligibleSkills) { candidates.push({ technicianId: String(technician.technicianId), cost: 1, breakdown: { eligible: 0 }, weights: { skill: 0, workload: 0, distance: 0 }, omittedFactors: [!available ? "availability_or_shift_or_capacity" : "required_skills"] }); continue; }
        const relevantSkills = required.map((requirement) => skills.find((skill) => skill.code === requirement.code)!);
        const skillSlack = relevantSkills.length ? relevantSkills.reduce((sum, skill, index) => sum + (skill.level - required[index].minLevel) / Math.max(1, 5 - required[index].minLevel), 0) / relevantSkills.length : 0.5;
        const skillCost = Math.max(0, 1 - skillSlack);
        const workloadCost = Math.min(1, (activeLoad.get(String(technician.technicianId)) ?? 0) / Number(technician.maxConcurrentAssignments));
        const technicianLocation = technician.coordinates as Coordinates | undefined;
        const distanceKm = location && technicianLocation ? haversineKm(location, technicianLocation) : undefined;
        const weights = policy.weights;
        const effectiveWeights = { skill: weights.skill, workload: weights.workload, distance: distanceKm === undefined ? 0 : weights.distance };
        const totalWeight = effectiveWeights.skill + effectiveWeights.workload + effectiveWeights.distance;
        const breakdown = { skill: skillCost, workload: workloadCost, ...(distanceKm === undefined ? {} : { distance: Math.min(1, distanceKm / policy.maxDistanceKm) }) };
        const cost = totalWeight === 0 ? 0.5 : (skillCost * effectiveWeights.skill + workloadCost * effectiveWeights.workload + (breakdown.distance ?? 0) * effectiveWeights.distance) / totalWeight;
        candidates.push({ technicianId: String(technician.technicianId), cost, breakdown, weights: effectiveWeights, omittedFactors: distanceKm === undefined && weights.distance > 0 ? ["distance:no_verified_coordinates"] : [], ...(distanceKm === undefined ? {} : { distanceKm: round(distanceKm, 3) }) });
      }
      candidatesByIncident.push(candidates.filter((candidate) => candidate.breakdown.eligible !== 0).sort((a, b) => a.cost - b.cost || a.technicianId.localeCompare(b.technicianId)));
      costMatrix.push(profiles.map((technician) => candidates.find((candidate) => candidate.technicianId === technician.technicianId && candidate.breakdown.eligible !== 0)?.cost ?? null));
    }
    const result = solveHungarianAssignment(costMatrix, unassignedCosts);
    const now = new Date().toISOString();
    const assignments: AuraRecord[] = result.matches.map((match, index) => {
      const incident = incidents[index]!;
      const candidate = match.technicianIndex === null ? undefined : candidatesByIncident[index].find((item) => item.technicianId === profiles[match.technicianIndex!].technicianId);
      const proposalId = hash(`${tenantId}|${idempotencyKey}|${incident.entityId}`);
      return { tenantId, entityType: "ASSIGNMENT", entityId: proposalId, assignmentId: proposalId, incidentId: incident.entityId, machineId: incident.machineId, severity: incident.severity, requiredSkills: input.requirements[incident.entityId] ?? [], technicianId: candidate?.technicianId ?? null, candidates: candidatesByIncident[index], cost: candidate?.cost ?? match.cost, costBreakdown: candidate?.breakdown ?? {}, costWeights: candidate?.weights ?? policy.weights, omittedFactors: candidate?.omittedFactors ?? [], ...(candidate && candidate.weights.skill + candidate.weights.workload + candidate.weights.distance === 0 ? { costExplanation: "No weighted signal was available; the neutral normalized cost was used" } : {}), distanceKm: candidate?.distanceKm, status: candidate ? "proposed" : "unassigned", confirmationAttempt: 1, version: 1, createdAt: now, updatedAt: now };
    });
    const eventRecords: AuraRecord[] = assignments.map((assignment) => auraEvent(tenantId, "AssignmentProposed", String(assignment.assignmentId), { incidentId: assignment.incidentId, technicianId: assignment.technicianId, cost: assignment.cost, unmatched: assignment.technicianId === null }, now));
    const response = { assignments, totalCost: result.totalCost, policyVersion: policyRecord.version, configured: Boolean(policyRecord.configured ?? policyRecord.version) };
    const ledger: AuraRecord = { tenantId, entityType: "IDEMPOTENCY", entityId: ledgerId, requestHash, response, createdAt: now, updatedAt: now, expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 };
    try {
      await this.repository.createMany([...assignments, ...eventRecords, ledger]);
    } catch (error) {
      const raced = await this.repository.get(tenantId, "IDEMPOTENCY", ledgerId);
      if (raced) return this.replayOptimization(tenantId, raced, requestHash);
      if (error instanceof AuraDuplicateError) throw new AuraConflictError("One or more incidents already have a proposal for this idempotency key");
      throw error;
    }
    const dispatchIds = assignments.filter((item) => item.technicianId).map((item) => String(item.assignmentId));
    if (dispatchIds.length && this.workflow) {
      try { await this.workflow.dispatch({ tenantId, assignmentIds: dispatchIds }); }
      catch { throw new AuraDispatchError(); }
    }
    return { ...response, workflowStarted: dispatchIds.length > 0 && Boolean(this.workflow), replayed: false };
  }

  async kpis(tenantId: string, from: string, to: string, responseSlaMinutes?: number) {
    const start = Date.parse(from), end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 366 * 24 * 60 * 60 * 1000) throw new ValidationError(["from and to must define an ISO period no longer than 366 days"]);
    const incidents = await this.allByTypeOperations(tenantId, "INCIDENT");
    const inPeriod = incidents.filter((incident) => { const at = Date.parse(String(incident.occurredAt ?? incident.createdAt)); return at >= start && at < end; });
    const resolved = inPeriod.map((incident) => ({ incident, resolvedAt: statusAt(incident, "resolved") })).filter((entry): entry is { incident: OperationalRecord; resolvedAt: string } => Boolean(entry.resolvedAt));
    const durations = resolved.map(({ incident, resolvedAt }) => Date.parse(resolvedAt) - Date.parse(String(incident.occurredAt ?? incident.createdAt))).filter((duration) => duration >= 0);
    const recurrenceWindowDays = 30;
    const recurrences = inPeriod.filter((incident) => incidents.some((earlier) => earlier.entityId !== incident.entityId && earlier.machineId === incident.machineId && Date.parse(String(earlier.occurredAt ?? earlier.createdAt)) < Date.parse(String(incident.occurredAt ?? incident.createdAt)) && Date.parse(String(incident.occurredAt ?? incident.createdAt)) - Date.parse(String(earlier.occurredAt ?? earlier.createdAt)) <= recurrenceWindowDays * 86_400_000));
    const acknowledgementSla = responseSlaMinutes && responseSlaMinutes > 0 ? responseSlaMinutes : undefined;
    const acknowledged = acknowledgementSla ? inPeriod.map((incident) => ({ incident, acknowledgedAt: statusAt(incident, "acknowledged") })).filter((entry): entry is { incident: OperationalRecord; acknowledgedAt: string } => Boolean(entry.acknowledgedAt)) : [];
    const met = acknowledgementSla ? acknowledged.filter(({ incident, acknowledgedAt }) => Date.parse(acknowledgedAt) - Date.parse(String(incident.createdAt)) <= acknowledgementSla * 60_000).length : 0;
    return {
      period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
      mttr: { averageMinutes: durations.length ? round(durations.reduce((sum, item) => sum + item, 0) / durations.length / 60_000, 2) : null, resolvedIncidentCount: durations.length },
      downtime: { totalMinutes: null, eligibleMachineTransitions: 0, reason: "Machine downtime transitions are not present in the current API contract" },
      recurrence: { windowDays: recurrenceWindowDays, recurrentIncidentCount: recurrences.length, incidentCount: inPeriod.length, percent: inPeriod.length ? round(recurrences.length / inPeriod.length * 100, 1) : null },
      responseSla: { responseSlaMinutes: acknowledgementSla ?? null, acknowledgedCount: acknowledged.length, withinSlaCount: met, compliancePercent: acknowledged.length ? round(met / acknowledged.length * 100, 1) : null },
    };
  }

  async captureCallback(input: { tenantId: string; assignmentId: string; phase: "confirmation" | "intervention"; attempt: number; taskToken: string; executionArn: string }) {
    if (!input.taskToken || input.taskToken.length > 2048 || !input.executionArn.startsWith("arn:aws:states:")) throw new ValidationError(["workflow callback context is invalid"]);
    const assignment = await this.repository.get(input.tenantId, "ASSIGNMENT", input.assignmentId);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const expected = input.phase === "confirmation" ? "proposed" : "in_progress";
    if (assignment.status !== expected) throw new AuraConflictError("Assignment is not waiting for this callback phase");
    const callbackId = `${input.assignmentId}:${input.phase}:${input.attempt}`;
    const old = await this.repository.get(input.tenantId, "CALLBACK", callbackId);
    if (old) {
      if (old.status === "waiting" && old.taskToken === input.taskToken) return { captured: true, replayed: true };
      throw new AuraConflictError("A callback token already exists for this assignment phase");
    }
    const now = new Date().toISOString();
    const callback: AuraRecord = { tenantId: input.tenantId, entityType: "CALLBACK", entityId: callbackId, callbackId, assignmentId: input.assignmentId, phase: input.phase, taskToken: input.taskToken, executionArn: input.executionArn, status: "waiting", version: 1, createdAt: now, updatedAt: now, expiresAt: Math.floor(Date.now() / 1000) + (input.phase === "confirmation" ? 12 : 24) * 60 * 60 + 3600 };
    const event = auraEvent(input.tenantId, "NotificationRequested", callbackId, { assignmentId: input.assignmentId, targetRole: "technician", phase: input.phase, deliveryStatus: "requested" }, now);
    try { await this.repository.createMany([callback, event]); }
    catch (error) {
      const raced = await this.repository.get(input.tenantId, "CALLBACK", callbackId);
      if (raced?.status === "waiting" && raced.taskToken === input.taskToken) return { captured: true, replayed: true };
      throw error;
    }
    return { captured: true, replayed: false };
  }

  async respondToAssignment(tenantId: string, assignmentId: string, phase: "confirmation" | "intervention", actor: { userSub: string; role: string }, input: { decision?: "accepted" | "rejected"; reason?: string; occurredAt?: string; notes?: string }) {
    const assignment = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    const attempt = phase === "confirmation" ? Number(assignment?.confirmationAttempt ?? 1) : Number(assignment?.interventionAttempt ?? 1);
    const callbackId = `${assignmentId}:${phase}:${attempt}`;
    const callback = await this.repository.get(tenantId, "CALLBACK", callbackId);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const technician = assignment.technicianId ? await this.repository.get(tenantId, "TECHNICIAN", String(assignment.technicianId)) : undefined;
    if (actor.role !== "owner" && actor.role !== "admin" && technician?.cognitoSub !== actor.userSub) throw new ValidationError(["Only the assigned technician or a tenant administrator may respond"]);
    let result: Record<string, unknown>;
    if (phase === "confirmation") {
      if (input.decision !== "accepted" && input.decision !== "rejected") throw new ValidationError(["decision must be accepted or rejected"]);
      if (input.decision === "rejected" && !input.reason?.trim()) throw new ValidationError(["reason is required to reject an assignment"]);
      result = { assignmentId, phase, decision: input.decision, reason: input.reason?.trim() };
    } else {
      if (!input.occurredAt || !input.notes?.trim()) throw new ValidationError(["occurredAt and notes are required to complete an intervention"]);
      const occurredAt = Date.parse(input.occurredAt);
      if (!Number.isFinite(occurredAt) || occurredAt > Date.now() + 5 * 60_000) throw new ValidationError(["occurredAt must be a valid timestamp no more than five minutes in the future"]);
      result = { assignmentId, phase, decision: "completed", occurredAt: new Date(occurredAt).toISOString(), notes: input.notes.trim() };
    }
    const responseHash = hash(JSON.stringify(result));
    if (!callback) throw new NotFoundError("Pending assignment callback not found");
    if (callback.status === "sent") {
      if (callback.responseHash === responseHash) return { assignmentId, phase, accepted: true, replayed: true };
      throw new AuraConflictError("Callback has already been completed with another response");
    }
    if (callback.status !== "waiting") throw new AuraConflictError("Callback is already being processed or has expired");
    if (!this.callbacks) throw new Error("Step Functions callback sender is not configured");
    const submitting = { ...callback, status: "submitting", responseHash, response: result, version: Number(callback.version) + 1, updatedAt: new Date().toISOString() };
    await this.repository.save(submitting, Number(callback.version));
    await this.callbacks.succeed(String(callback.taskToken), result);
    const sent = { ...submitting, status: "sent", taskToken: undefined, version: Number(submitting.version) + 1, updatedAt: new Date().toISOString() };
    await this.repository.save(sent, Number(submitting.version));
    await this.repository.createMany([auraEvent(tenantId, "AssignmentCallbackAccepted", callbackId, { assignmentId, phase, decision: result.decision, actorSub: actor.userSub }, sent.updatedAt)]);
    return { assignmentId, phase, accepted: true, replayed: false };
  }

  async nextCandidate(tenantId: string, assignmentId: string, reason: string, expectedAttempt?: number) {
    const assignment = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const currentAttempt = Number(assignment.confirmationAttempt ?? 1);
    if (expectedAttempt !== undefined && currentAttempt > expectedAttempt) {
      if (assignment.status === "proposed" && assignment.technicianId) return { candidateFound: true, assignmentId, technicianId: assignment.technicianId, attempt: currentAttempt, replayed: true };
      return { candidateFound: false, assignmentId, replayed: true };
    }
    if (expectedAttempt !== undefined && currentAttempt !== expectedAttempt) throw new AuraConflictError("Assignment confirmation attempt changed");
    if (assignment.status === "escalated") return { candidateFound: false, assignmentId, replayed: true };
    const expiredAttempt = Number(assignment.confirmationAttempt ?? 1);
    const pendingCallback = await this.repository.get(tenantId, "CALLBACK", `${assignmentId}:confirmation:${expiredAttempt}`);
    if (pendingCallback?.status === "waiting") await this.repository.save({ ...pendingCallback, status: "expired", taskToken: undefined, version: Number(pendingCallback.version) + 1, updatedAt: new Date().toISOString() }, Number(pendingCallback.version));
    const attempts = Array.isArray(assignment.attempts) ? [...assignment.attempts as Array<Record<string, unknown>>] : [];
    if (assignment.technicianId && !attempts.some((attempt) => attempt.technicianId === assignment.technicianId)) attempts.push({ technicianId: assignment.technicianId, reason: reason.slice(0, 300), at: new Date().toISOString() });
    const tried = new Set(attempts.map((attempt) => String(attempt.technicianId)));
    const candidates = Array.isArray(assignment.candidates) ? assignment.candidates as Array<Record<string, unknown>> : [];
    let selected: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      if (tried.has(String(candidate.technicianId))) continue;
      const profile = await this.repository.get(tenantId, "TECHNICIAN", String(candidate.technicianId));
      if (!profile || profile.status !== "active" || profile.availability !== "available" || !isOnShift(profile.shifts, new Date())) continue;
      const active = await this.allByType(tenantId, "ASSIGNMENT");
      const load = active.filter((item) => item.technicianId === profile.technicianId && item.assignmentId !== assignmentId && !terminalAssignmentStates.has(String(item.status))).length;
      if (load >= Number(profile.maxConcurrentAssignments)) continue;
      selected = candidate; break;
    }
    const now = new Date().toISOString();
    if (!selected) {
      const escalated = { ...assignment, attempts, status: "escalated", escalationReason: reason, version: Number(assignment.version) + 1, updatedAt: now };
      await this.repository.save(escalated, Number(assignment.version));
      await this.repository.createMany([auraEvent(tenantId, "AssignmentEscalated", assignmentId, { incidentId: assignment.incidentId, reason, attempts: attempts.length }, now)]);
      return { candidateFound: false, assignmentId };
    }
    const attempt = currentAttempt + 1;
    const updated = { ...assignment, attempts, technicianId: selected.technicianId, cost: selected.cost, costBreakdown: selected.breakdown, distanceKm: selected.distanceKm, status: "proposed", confirmationAttempt: attempt, version: Number(assignment.version) + 1, updatedAt: now };
    await this.repository.save(updated, Number(assignment.version));
    await this.repository.createMany([auraEvent(tenantId, "AssignmentReassigned", assignmentId, { incidentId: assignment.incidentId, technicianId: selected.technicianId, reason }, now)]);
    return { candidateFound: true, assignmentId, technicianId: selected.technicianId, attempt };
  }

  async markAccepted(tenantId: string, assignmentId: string, technicianId: string) {
    const assignment = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    if (!assignment) throw new NotFoundError("Assignment not found");
    if ((assignment.status === "accepted" || assignment.status === "in_progress") && assignment.technicianId !== technicianId) throw new AuraConflictError("Assignment candidate no longer matches workflow input");
    if (assignment.status !== "accepted" && assignment.status !== "in_progress") {
      if (assignment.status !== "proposed" || assignment.technicianId !== technicianId) throw new AuraConflictError("Assignment candidate no longer matches workflow input");
      const accepted = { ...assignment, status: "accepted", acceptedAt: new Date().toISOString(), version: Number(assignment.version) + 1, updatedAt: new Date().toISOString() };
      await this.repository.save(accepted, Number(assignment.version));
    }
    const now = new Date().toISOString();
    await this.updateIncidentForWorkflow(tenantId, String(assignment.incidentId), "acknowledged", { assignedTo: technicianId }, now);
    const workOrder = await this.findWorkOrder(tenantId, String(assignment.incidentId));
    if (workOrder && workOrder.status === "planned") await this.updateWorkOrderForWorkflow(tenantId, workOrder, "in_progress", undefined, now);
    const current = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    if (!current) throw new AuraConflictError();
    if (current.status === "in_progress") return current;
    if (current.status !== "accepted") throw new AuraConflictError();
    const inProgress = { ...current, status: "in_progress", interventionStartedAt: now, version: Number(current.version) + 1, updatedAt: now };
    await this.repository.save(inProgress, Number(current.version));
    return inProgress;
  }

  async closeIntervention(tenantId: string, assignmentId: string, input: { occurredAt: string; notes: string }) {
    const assignment = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (!["in_progress", "completed"].includes(String(assignment.status))) throw new AuraConflictError("Assignment is not in intervention state");
    const workOrder = await this.findWorkOrder(tenantId, String(assignment.incidentId));
    if (workOrder && assignment.status === "in_progress") {
      const reservations = await this.allByType(tenantId, "RESERVATION");
      for (const reservation of reservations.filter((item) => item.workOrderId === workOrder.entityId && item.status === "active")) await this.settleReservation(tenantId, String(reservation.reservationId), "consume");
    }
    const replayed = assignment.status === "completed";
    const now = new Date().toISOString();
    const completed = replayed ? assignment : { ...assignment, status: "completed", intervention: { occurredAt: input.occurredAt, notes: input.notes }, completedAt: now, version: Number(assignment.version) + 1, updatedAt: now };
    if (assignment.status !== "completed") await this.repository.save(completed, Number(assignment.version));
    await this.updateIncidentForWorkflow(tenantId, String(assignment.incidentId), "resolved", { resolution: input.notes }, now);
    const currentOrder = await this.findWorkOrder(tenantId, String(assignment.incidentId));
    if (currentOrder && currentOrder.status === "in_progress") await this.updateWorkOrderForWorkflow(tenantId, currentOrder, "completed", { occurredAt: input.occurredAt, notes: input.notes }, now);
    return { assignment: completed, replayed };
  }

  async failAssignment(tenantId: string, assignmentId: string, reason: string) {
    const assignment = await this.repository.get(tenantId, "ASSIGNMENT", assignmentId);
    if (!assignment) return { expired: true };
    const phase = assignment.status === "in_progress" ? "intervention" : "confirmation";
    const attempt = phase === "confirmation" ? Number(assignment.confirmationAttempt ?? 1) : Number(assignment.interventionAttempt ?? 1);
    const callback = await this.repository.get(tenantId, "CALLBACK", `${assignmentId}:${phase}:${attempt}`);
    if (callback?.status === "waiting") await this.repository.save({ ...callback, status: "expired", taskToken: undefined, version: Number(callback.version) + 1, updatedAt: new Date().toISOString() }, Number(callback.version));
    if (assignment.status === "in_progress") {
      const now = new Date().toISOString();
      const failed = { ...assignment, status: "escalated", escalationReason: reason, version: Number(assignment.version) + 1, updatedAt: now };
      await this.repository.save(failed, Number(assignment.version));
      await this.repository.createMany([auraEvent(tenantId, "AssignmentEscalated", assignmentId, { incidentId: assignment.incidentId, phase, reason }, now)]);
      return { expired: true };
    }
    return this.nextCandidate(tenantId, assignmentId, reason);
  }

  private async findWorkOrder(tenantId: string, incidentId: string) {
    const orders = await this.allByTypeOperations(tenantId, "WORK_ORDER");
    return orders.find((order) => order.incidentId === incidentId && !["completed", "cancelled"].includes(String(order.status)));
  }

  private async updateIncidentForWorkflow(tenantId: string, incidentId: string, status: "acknowledged" | "resolved", patch: Record<string, unknown>, now: string) {
    const current = await this.operations.get(tenantId, "INCIDENT", incidentId);
    if (!current) throw new NotFoundError("Incident not found");
    if (current.status === status || (status === "acknowledged" && current.status === "resolved")) return current;
    if (status === "resolved" && current.status !== "acknowledged" && current.status !== "open") throw new AuraConflictError("Incident cannot be resolved from its current state");
    const version = Number(current.version ?? 1);
    const updated = { ...current, ...patch, status, history: [...(Array.isArray(current.history) ? current.history : []), { status, at: now, actor: "aura-workflow" }], version: version + 1, updatedAt: now };
    await this.operations.updateWithEvents(updated, version, [operationalEvent(tenantId, "IncidentUpdated", incidentId, String(current.machineId), { status, source: "aura-workflow", version: version + 1 }, now, String(version + 1))]);
    return updated;
  }

  private async updateWorkOrderForWorkflow(tenantId: string, current: OperationalRecord, status: "in_progress" | "completed", intervention: { occurredAt: string; notes: string } | undefined, now: string) {
    const version = Number(current.version ?? 1);
    const updated = { ...current, status, history: [...(Array.isArray(current.history) ? current.history : []), { status, at: now, source: "aura-workflow" }], interventions: [...(Array.isArray(current.interventions) ? current.interventions : []), ...(intervention ? [intervention] : [])], version: version + 1, updatedAt: now };
    await this.operations.updateWithEvents(updated, version, [operationalEvent(tenantId, "MaintenanceOrderUpdated", String(current.entityId), String(current.machineId), { status, source: "aura-workflow", version: version + 1 }, now, String(version + 1))]);
    return updated;
  }

  private async allByTypeOperations(tenantId: string, type: "INCIDENT" | "WORK_ORDER") {
    const items: OperationalRecord[] = [];
    let cursor: string | undefined;
    do { const page = await this.operations.queryByType(tenantId, type, 100, cursor); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
    return items;
  }

  private async replayOptimization(tenantId: string, prior: AuraRecord, requestHash: string) {
    if (prior.requestHash !== requestHash) throw new AuraConflictError("idempotency-key was already used with another assignment request");
    const response = prior.response as { assignments: AuraRecord[]; totalCost: number; policyVersion: number; configured: boolean };
    const dispatchIds = response.assignments.filter((assignment) => assignment.technicianId && assignment.status === "proposed").map((item) => String(item.assignmentId));
    if (dispatchIds.length && this.workflow) {
      try { await this.workflow.dispatch({ tenantId, assignmentIds: dispatchIds }); } catch { throw new AuraDispatchError(); }
    }
    return { ...response, workflowStarted: dispatchIds.length > 0 && Boolean(this.workflow), replayed: true };
  }

  private async allByType(tenantId: string, type: AuraEntityType) {
    const items: AuraRecord[] = [];
    let cursor: string | undefined;
    do { const page = await this.repository.queryByType(tenantId, type, 100, cursor); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
    return items;
  }
}

export function stockIdentity(partId: string, locationId: string) { return hash(`${partId}|${locationId}`); }
export function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function auraEvent(tenantId: string, eventType: string, resourceId: string, payload: Record<string, unknown>, now: string): AuraRecord {
  const eventId = hash(`${tenantId}|${eventType}|${resourceId}`);
  return { tenantId, entityType: "EVENT", entityId: eventId, eventId, eventType, resourceId, payload, createdAt: now, updatedAt: now };
}
function operationalEvent(tenantId: string, eventType: string, resourceId: string, machineId: string, payload: Record<string, unknown>, now: string, version: string): OperationalRecord {
  const eventId = hash(`${eventType}|${resourceId}|${version}`);
  return { tenantId, entityType: "EVENT", entityId: eventId, eventId, eventType, resourceId, machineId, timestamp: now, payload, createdAt: now, updatedAt: now };
}
function statusAt(incident: OperationalRecord, status: string): string | undefined {
  const history = Array.isArray(incident.history) ? incident.history as Array<Record<string, unknown>> : [];
  return history.find((entry) => entry.status === status && typeof entry.at === "string")?.at as string | undefined;
}
function isOnShift(shifts: unknown, at: Date) {
  if (!Array.isArray(shifts) || !shifts.length) return false;
  return shifts.some((shift) => {
    if (!shift || typeof shift !== "object") return false;
    const row = shift as { daysOfWeek?: number[]; startTime?: string; endTime?: string; timeZone?: string };
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: row.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
      const val = (type: string) => parts.find((part) => part.type === type)?.value;
      const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[val("weekday") ?? ""];
      const now = `${val("hour")}:${val("minute")}`;
      const start = row.startTime ?? "99:99", end = row.endTime ?? "00:00";
      const dayMatches = row.daysOfWeek?.includes(weekday);
      return start < end ? Boolean(dayMatches && now >= start && now < end) : Boolean(dayMatches && now >= start || row.daysOfWeek?.includes((weekday + 6) % 7) && now < end);
    } catch { return false; }
  });
}
function haversineKm(a: Coordinates, b: Coordinates) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function round(value: number, decimals: number) { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }
