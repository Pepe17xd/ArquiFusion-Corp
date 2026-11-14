import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSupervisor } from "../supervisor/supervisor";
import { PermanentTaskError } from "../supervisor/contracts";
import { LocalTaskStore } from "../supervisor/local-task-store";
import { createEvent, validateEvent } from "../supervisor/event-contract";
import { EVENT_TYPES } from "../supervisor/event-contract";
import { readFile } from "node:fs/promises";
import { listAgents } from "../supervisor/registry";
import { LocalMachineRepository } from "../storage/local-machine-repository";
import type { IntelligenceProvider } from "../intelligence/contracts";
import { createLocalServer } from "../local-server";
import { LocalOriginalFileStore } from "../storage/local-original-file-store";
import { StepFunctionsTaskDispatcher } from "../supervisor/step-functions-dispatcher";

const tempRoot = tmpdir();
const noMachines = (file: string) => new LocalMachineRepository(file);

test("shared v1 event envelope validates and rejects unknown fields", () => {
  const event = createEvent({ eventType: "AgentTaskRequested", tenantId: "local-demo", taskId: "t", executionId: "x", correlationId: "c", payload: {} });
  assert.equal(validateEvent(event), true);
  assert.equal(validateEvent({ ...event, token: "not-allowed" }), false);
});

test("TypeScript event types stay aligned with the shared JSON schema", async () => {
  const schema = JSON.parse(await readFile(resolve(__dirname, "../../../shared/contracts/events.schema.json"), "utf8"));
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.eventType.enum].sort());
});

test("agent registry exposes only the deterministic fleet workflow as operational", () => {
  const agents = listAgents();
  assert.equal(agents.filter((agent) => agent.status === "operational").length, 1);
  assert.equal(agents.find((agent) => agent.id === "fleet-intelligence")?.capabilities[0], "fleet.recommendations");
  assert.ok(agents.filter((agent) => agent.id !== "fleet-intelligence").every((agent) => agent.status === "planned"));
});

test("supervisor refuses tasks outside the explicit capability registry", async () => {
  const dir = await mkdtemp(join(tempRoot, ".test-supervisor-capability-"));
  try {
    const supervisor = new AgentSupervisor(new LocalTaskStore(join(dir, "supervisor.json")), noMachines(join(dir, "machines.json")));
    await assert.rejects(supervisor.submit({ tenantId: "local-demo", taskType: "inventory.recommendations" }), PermanentTaskError);
    assert.equal((await supervisor.list("local-demo")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Step Functions dispatcher sends stable execution identity and tenant context", async () => {
  const sent: import("@aws-sdk/client-sfn").StartExecutionCommand[] = [];
  const dispatcher = new StepFunctionsTaskDispatcher("arn:aws:states:us-east-1:123456789012:stateMachine:test", {
    send: async (command) => { sent.push(command); return {}; },
  });
  const input = { tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", correlationId: "request-1" };
  await dispatcher.dispatch(input);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].input.name, input.executionId);
  assert.equal(sent[0].input.stateMachineArn, "arn:aws:states:us-east-1:123456789012:stateMachine:test");
  assert.deepEqual(JSON.parse(sent[0].input.input ?? "{}"), input);
});

test("dispatcher failures persist a terminal task and idempotent replay does not dispatch again", async () => {
  const dir = await mkdtemp(join(tempRoot, ".test-supervisor-dispatch-failure-"));
  try {
    let dispatches = 0;
    const store = new LocalTaskStore(join(dir, "supervisor.json"));
    const supervisor = new AgentSupervisor(store, noMachines(join(dir, "machines.json")), undefined, undefined, {
      dispatch: async () => { dispatches += 1; throw new Error("transport unavailable"); },
    });
    const first = await supervisor.submit({ tenantId: "tenant-a", taskType: "fleet.recommendations", idempotencyKey: "retry-safe" });
    const replay = await supervisor.submit({ tenantId: "tenant-a", taskType: "fleet.recommendations", idempotencyKey: "retry-safe" });
    assert.equal(first.task.state, "FAILED");
    assert.equal(first.task.error?.code, "DISPATCH_FAILURE");
    assert.equal(replay.created, false);
    assert.equal(replay.task.taskId, first.task.taskId);
    assert.equal(dispatches, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("supervisor persists, routes and deduplicates a supported task", async () => {
  const dir = await mkdtemp(join(tempRoot, ".test-supervisor-"));
  try {
    let runs = 0;
    const provider: IntelligenceProvider = { recommend: async () => { runs += 1; return { generatedAt: new Date().toISOString(), recommendations: [], source: "deterministic-rules" }; } };
    const store = new LocalTaskStore(join(dir, "supervisor.json"));
    const supervisor = new AgentSupervisor(store, noMachines(join(dir, "machines.json")), provider, async () => undefined);
    const first = await supervisor.submit({ tenantId: "local-demo", taskType: "fleet.recommendations", idempotencyKey: "same-request" });
    const duplicate = await supervisor.submit({ tenantId: "local-demo", taskType: "fleet.recommendations", idempotencyKey: "same-request" });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.task.taskId, duplicate.task.taskId);
    const completed = await waitForTerminal(supervisor, first.task.taskId);
    assert.equal(completed.state, "SUCCEEDED");
    assert.equal(runs, 1);
    const eventLog = await supervisor.events("local-demo", first.task.taskId);
    assert.deepEqual(eventLog.map((event) => event.eventType), ["AgentTaskRequested", "AgentTaskAssigned", "AgentTaskStarted", "AgentTaskCompleted"]);
    const otherTenant = await supervisor.submit({ tenantId: "tenant-b", taskType: "fleet.recommendations", idempotencyKey: "same-request" });
    assert.equal(otherTenant.created, true);
    assert.notEqual(otherTenant.task.taskId, first.task.taskId);
    await waitForTerminal(supervisor, otherTenant.task.taskId, "tenant-b");
    assert.equal(runs, 2);
    assert.equal(await supervisor.get("tenant-b", first.task.taskId), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("transient provider failures retry to the local dead-letter state", async () => {
  const dir = await mkdtemp(join(tempRoot, ".test-supervisor-retry-"));
  try {
    let runs = 0;
    const provider: IntelligenceProvider = { recommend: async () => { runs += 1; throw new Error("private provider detail"); } };
    const supervisor = new AgentSupervisor(new LocalTaskStore(join(dir, "supervisor.json")), noMachines(join(dir, "machines.json")), provider, async () => undefined);
    const submitted = await supervisor.submit({ tenantId: "local-demo", taskType: "fleet.recommendations", idempotencyKey: "retry-request" });
    const task = await waitForTerminal(supervisor, submitted.task.taskId);
    assert.equal(task.state, "DEAD_LETTER");
    assert.equal(task.attempts, 3);
    assert.equal(runs, 3);
    assert.equal(task.error?.message.includes("private provider detail"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local API exposes agents, task submission, task status, events and consolidated overview", async () => {
  const dir = await mkdtemp(join(tempRoot, ".test-supervisor-api-"));
  const server = createLocalServer({ machines: new LocalMachineRepository(join(dir, "machines.json")), originals: new LocalOriginalFileStore(join(dir, "uploads")), tasks: new LocalTaskStore(join(dir, "supervisor.json")), tenants: new (await import("../tenancy/local-tenant-directory")).LocalTenantDirectory(join(dir, "tenants.json")) });
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const agents = await fetch(`${base}/agents`).then((response) => response.json()) as any;
    assert.equal(agents.data.find((agent: any) => agent.status === "operational").id, "fleet-intelligence");
    const submission = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations", idempotencyKey: "api-task-key" }) }).then((response) => response.json()) as any;
    assert.equal(submission.data.created, true);
    const taskId = submission.data.task.taskId as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = await fetch(`${base}/tasks/${taskId}`).then((response) => response.json()) as any;
      if (task.data.state === "SUCCEEDED") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    const events = await fetch(`${base}/events?taskId=${taskId}`).then((response) => response.json()) as any;
    assert.deepEqual(events.data.map((event: any) => event.eventType), ["AgentTaskRequested", "AgentTaskAssigned", "AgentTaskStarted", "AgentTaskCompleted"]);
    const overview = await fetch(`${base}/operations/overview`).then((response) => response.json()) as any;
    assert.equal(overview.data.tasks.succeeded, 1);
    assert.equal(overview.data.agents.filter((agent: any) => agent.status === "operational").length, 1);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForTerminal(supervisor: AgentSupervisor, taskId: string, tenantId = "local-demo") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const task = await supervisor.get(tenantId, taskId);
    if (task && ["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state)) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Task did not reach a terminal state");
}
