/** AWS ports are deliberately not wired to a deployed service. Implementations must use
 * a DynamoDB transaction for message claim plus outbox, conditional version/lease updates,
 * and SQS receipt handles with visibility renewal and delete only after durable completion.
 * SENDING with an expired lease must be quarantined as ambiguous, never resent. */
export interface DynamoMailJobOperations {
  createWithOutbox(messageId: string, tenantId: string, payloadReference: string): Promise<boolean>;
  claim(messageId: string, owner: string, fencingToken: string, now: number, expires: number): Promise<boolean>;
  compareAndSet(messageId: string, fencingToken: string, expectedVersion: number, update: unknown): Promise<boolean>;
}
export interface SqsJobOperations {
  publish(messageId: string): Promise<void>;
  receive(): Promise<{ messageId: string; receiptHandle: string } | undefined>;
  extendVisibility(receiptHandle: string, seconds: number): Promise<void>;
  acknowledge(receiptHandle: string): Promise<void>;
}
