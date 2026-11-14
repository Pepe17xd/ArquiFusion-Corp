import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { TaskDispatcher } from "./contracts";

export class StepFunctionsTaskDispatcher implements TaskDispatcher {
  private readonly client = new SFNClient({});
  constructor(private readonly stateMachineArn: string) {}

  async dispatch(input: { tenantId: string; taskId: string }) {
    await this.client.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      name: input.taskId,
      input: JSON.stringify(input),
    }));
  }
}
