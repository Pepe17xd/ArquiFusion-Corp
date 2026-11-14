import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { TaskDispatcher } from "./contracts";

export interface StartExecutionClient {
  send(command: StartExecutionCommand): Promise<unknown>;
}

export class StepFunctionsTaskDispatcher implements TaskDispatcher {
  private readonly client: StartExecutionClient;
  constructor(private readonly stateMachineArn: string, client: StartExecutionClient = new SFNClient({})) { this.client = client; }

  async dispatch(input: { tenantId: string; taskId: string; executionId: string; correlationId: string }) {
    await this.client.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      name: input.executionId,
      input: JSON.stringify(input),
    }));
  }
}
