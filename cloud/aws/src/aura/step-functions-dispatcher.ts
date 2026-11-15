import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { AuraWorkflowDispatcher } from "./service";

export class StepFunctionsAuraDispatcher implements AuraWorkflowDispatcher {
  private readonly client = new SFNClient({});
  constructor(private readonly stateMachineArn: string) {}
  async dispatch(input: { tenantId: string; assignmentIds: string[] }) {
    for (const assignmentId of input.assignmentIds) {
      const name = `a-${Buffer.from(`${input.tenantId}|${assignmentId}`).toString("hex").slice(0, 70)}`;
      try {
        await this.client.send(new StartExecutionCommand({ stateMachineArn: this.stateMachineArn, name, input: JSON.stringify({ tenantId: input.tenantId, assignmentId, attempt: 1 }) }));
      } catch (error) {
        if ((error as { name?: string }).name !== "ExecutionAlreadyExists") throw error;
      }
    }
  }
}
