import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { LocalTaskStore } from "../supervisor/local-task-store";
import { DynamoTaskStore, type TaskDocumentClient } from "../supervisor/dynamo-task-store";
import { TaskConflictError, type AgentEvent, type TaskRecord, type TaskStore } from "../supervisor/contracts";
import { createEvent } from "../supervisor/event-contract";

function newTask(tenantId = "tenant-a"): TaskRecord {
  return { tenantId, taskId: "task-1", executionId: "execution-1", correlationId: "correlation-1", taskType: "fleet.recommendations", agentId: "fleet-intelligence", payload: {}, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), state: "QUEUED", version: 1, attempts: 0, maxAttempts: 3, idempotencyKey: "idem-1" };
}

function event(task: TaskRecord, eventType: string, payload: Record<string, unknown> = {}): AgentEvent {
  return createEvent({ eventType: eventType as any, tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload });
}

async function withStore(make: (file: string) => TaskStore, run: (store: TaskStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), ".arquifusion-task-version-"));
  try {
    const store = make(join(directory, "tasks.json"));
    const task = newTask();
    await store.create(task, event(task, "AgentTaskRequested"));
    await store.update(task, event(task, "AgentTaskAssigned", { agentId: task.agentId }));
    await run(store, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const local = (file: string) => new LocalTaskStore(file);
const dynamo = (file: string) => new DynamoTaskStore("tasks-test", new MemoryDynamoClient());

for (const [label, factory] of [["local", local], ["DynamoDB command adapter", dynamo]] as const) {
  test(`${label}: two workers cannot claim the same task concurrently`, async () => withStore(factory, async (store) => {
    const attempts = await Promise.allSettled([
      store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-A", now: 1000, leaseDurationMs: 50 }),
      store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-B", now: 1000, leaseDurationMs: 50 }),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled" && item.value.acquired).length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason instanceof TaskConflictError && item.reason.code === "CLAIM_CONFLICT").length, 1);
    const claimed = await store.get("tenant-a", "task-1");
    assert.equal(claimed?.state, "RUNNING");
    assert.equal(claimed?.version, 3);
    assert.equal(claimed?.attempts, 1);
    assert.equal((await store.events("tenant-a", "task-1")).filter((item) => item.eventType === "AgentTaskStarted").length, 1);
  }));

  test(`${label}: concurrent updates with the same version have one winner`, async () => withStore(factory, async (store) => {
    const claim = await store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-A", now: 1000, leaseDurationMs: 50 });
    const successful = { ...claim.task, state: "SUCCEEDED" as const, result: { generatedAt: new Date(1000).toISOString(), recommendations: [], source: "deterministic-rules" as const } };
    const retrying = { ...claim.task, state: "RETRYING" as const, error: { code: "TRANSIENT", message: "temporary", retryable: true } };
    const results = await Promise.allSettled([
      store.update(successful, event(claim.task, "AgentTaskCompleted")),
      store.update(retrying, event(claim.task, "AgentTaskFailed", { code: "TRANSIENT" })),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = results.find((item) => item.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof TaskConflictError);
    assert.equal(rejected.reason.code, "VERSION_CONFLICT");
    assert.equal((await store.get("tenant-a", "task-1"))?.version, 4);
  }));

  test(`${label}: terminal state cannot transition back to a running state`, async () => withStore(factory, async (store) => {
    const claimed = await store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-A", now: 1000, leaseDurationMs: 50 });
    const completed = await store.update({ ...claimed.task, state: "SUCCEEDED", result: { generatedAt: new Date(1000).toISOString(), recommendations: [], source: "deterministic-rules" } }, event(claimed.task, "AgentTaskCompleted"));
    await assert.rejects(store.update({ ...completed, state: "RUNNING" }, event(completed, "AgentTaskStarted")), (error) => error instanceof TaskConflictError && error.code === "INVALID_TRANSITION");
  }));

  test(`${label}: expired claim can be recovered but the former worker becomes stale`, async () => withStore(factory, async (store) => {
    const first = await store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-A", now: 1000, leaseDurationMs: 50 });
    const recovered = await store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-B", now: 1050, leaseDurationMs: 50 });
    assert.equal(recovered.acquired, true);
    assert.equal(recovered.task.version, first.task.version + 1);
    assert.equal(recovered.task.attempts, 2);
    assert.equal(recovered.task.claim?.workerId, "worker-B");
    await assert.rejects(store.update({ ...first.task, state: "SUCCEEDED" }, event(first.task, "AgentTaskCompleted")), (error) => error instanceof TaskConflictError && error.code === "VERSION_CONFLICT");
  }));

  test(`${label}: retrying the same transition is idempotent and writes one event`, async () => withStore(factory, async (store) => {
    const claimed = await store.claim({ tenantId: "tenant-a", taskId: "task-1", executionId: "execution-1", workerId: "worker-A", now: 1000, leaseDurationMs: 50 });
    const candidate = { ...claimed.task, state: "SUCCEEDED" as const, result: { generatedAt: new Date(1000).toISOString(), recommendations: [], source: "deterministic-rules" as const } };
    const transition = event(claimed.task, "AgentTaskCompleted", { resultCount: 0 });
    const first = await store.update(candidate, transition);
    const retry = await store.update(candidate, transition);
    assert.equal(first.version, retry.version);
    assert.equal((await store.events("tenant-a", "task-1")).filter((item) => item.eventType === "AgentTaskCompleted").length, 1);
  }));
}

test("legacy records without a version normalize to one and accept a conditional first update", async () => {
  const directory = await mkdtemp(join(tmpdir(), ".arquifusion-legacy-task-"));
  try {
    const file = join(directory, "tasks.json");
    const task = newTask();
    const { version: _version, ...legacy } = task;
    await writeFile(file, JSON.stringify({ tasks: [legacy], events: [] }));
    const store = new LocalTaskStore(file);
    const current = await store.get(task.tenantId, task.taskId);
    assert.equal(current?.version, 1);
    const failed = await store.update({ ...current!, state: "FAILED" }, event(current!, "AgentTaskFailed", { code: "legacy-test" }));
    assert.equal(failed.version, 2);
    assert.equal(JSON.parse(await readFile(file, "utf8")).tasks[0].version, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("DynamoDB conditional update accepts a legacy item without version exactly once", async () => {
  const task = newTask();
  const { version: _version, ...legacy } = task;
  const client = new MemoryDynamoClient();
  client.seed({ pk: task.tenantId, sk: `TASK#${task.taskId}`, kind: "TASK", task: legacy });
  const store = new DynamoTaskStore("tasks-test", client);
  const current = await store.get(task.tenantId, task.taskId);
  assert.equal(current?.version, 1);
  const failed = await store.update({ ...current!, state: "FAILED" }, event(current!, "AgentTaskFailed", { code: "legacy-test" }));
  assert.equal(failed.version, 2);
  assert.equal((await store.get(task.tenantId, task.taskId))?.version, 2);
  assert.equal((await store.events(task.tenantId, task.taskId)).length, 1);
});

class MemoryDynamoClient implements TaskDocumentClient {
  private readonly rows = new Map<string, any>();
  private pending: Promise<void> = Promise.resolve();

  seed(item: any) { this.rows.set(key(item), structuredClone(item)); }

  async send(command: any): Promise<any> {
    const prior = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return this.execute(command); } finally { release(); }
  }

  private execute(command: any): any {
    const input: any = command.input;
    if (command instanceof GetCommand) {
      const item = this.rows.get(key(input.Key));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command instanceof QueryCommand) {
      const tenantId = input.ExpressionAttributeValues[":tenant"];
      return { Items: [...this.rows.values()].filter((item) => item.pk === tenantId).map((item) => structuredClone(item)) };
    }
    assert.ok(command instanceof TransactWriteCommand);
    const staged: Array<{ key: string; item: any }> = [];
    for (const operation of input.TransactItems) {
      if (operation.Put) {
        const item = operation.Put.Item;
        const itemKey = key(item);
        if (operation.Put.ConditionExpression?.includes("attribute_not_exists") && this.rows.has(itemKey)) throw transactionCanceled();
        staged.push({ key: itemKey, item: structuredClone(item) });
      } else if (operation.Update) {
        const update = operation.Update;
        const itemKey = key(update.Key);
        const existing = this.rows.get(itemKey);
        if (!existing || !conditionMatches(existing, update)) throw transactionCanceled();
        staged.push({ key: itemKey, item: { ...structuredClone(existing), task: structuredClone(update.ExpressionAttributeValues[":next"]) } });
      } else throw new Error("Unexpected transaction operation");
    }
    for (const item of staged) this.rows.set(item.key, item.item);
    return {};
  }
}

function key(value: { pk: string; sk: string }) { return `${value.pk}\u0000${value.sk}`; }
function transactionCanceled() { return Object.assign(new Error("Conditional transaction canceled"), { name: "TransactionCanceledException" }); }
function conditionMatches(existing: any, update: any) {
  const task = existing.task;
  const values = update.ExpressionAttributeValues;
  if (task.state !== values[":state"]) return false;
  if (task.version === undefined ? values[":expected"] !== 1 || !update.ConditionExpression.includes("attribute_not_exists(#task.#version)") : task.version !== values[":expected"]) return false;
  const names = update.ExpressionAttributeNames;
  if (update.ConditionExpression.includes("attribute_not_exists(#task.#claim) OR")) {
    const claim = task.claim;
    if (claim && claim.leaseExpiresAt > values[":now"] && !(claim.workerId === values[":worker"] && claim.executionId === values[":execution"])) return false;
  } else if (update.ConditionExpression.includes("#task.#claim.#worker = :worker")) {
    if (task.claim?.workerId !== values[":worker"] || task.claim?.executionId !== values[":execution"]) return false;
  }
  assert.equal(names["#task"], "task");
  return true;
}
