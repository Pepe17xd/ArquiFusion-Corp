import { createHash, randomUUID } from "node:crypto";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { WorkflowDispatcher } from "./service";

export class StepFunctionsAnomalyDispatcher implements WorkflowDispatcher {
  private readonly client: { send(command: StartExecutionCommand): Promise<unknown> };
  constructor(private readonly stateMachineArn: string, client: { send(command: StartExecutionCommand): Promise<unknown> } = new SFNClient({})) { this.client = client; }
  async dispatch(input: { tenantId: string; anomalyId: string }) {
    const identity = createHash("sha256").update(`${input.tenantId}|${input.anomalyId}`).digest("hex").slice(0, 32);
    const attempt = `${Date.now().toString(36)}-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 8)}`;
    await this.client.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      name: `op-${identity}-${attempt}`,
      input: JSON.stringify(input),
    }));
  }
}
