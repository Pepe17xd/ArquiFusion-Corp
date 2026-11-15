import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const stage = process.env.AURA_BACKFILL_STAGE;
const table = process.env.OPERATIONS_TABLE;
const tenantId = process.env.AURA_BACKFILL_TENANT_ID;
if (stage !== "dev" || process.env.AURA_BACKFILL_CONFIRM !== "dev-only" || !table || !/-dev$/.test(table) || !tenantId) {
  throw new Error("Refusing backfill: set AURA_BACKFILL_STAGE=dev, AURA_BACKFILL_CONFIRM=dev-only, AURA_BACKFILL_TENANT_ID and a *-dev OPERATIONS_TABLE");
}
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }));
let startKey;
let updated = 0;
let skipped = 0;
do {
  const page = await db.send(new QueryCommand({
    TableName: table,
    IndexName: "ByTenantType",
    KeyConditionExpression: "gsi2pk = :partition",
    ExpressionAttributeValues: { ":partition": `TENANT#${tenantId}#TYPE#WORK_ORDER` },
    ExclusiveStartKey: startKey,
  }));
  for (const item of page.Items ?? []) {
    if (typeof item.assignedTechnicianId !== "string" || typeof item.updatedAt !== "string" || typeof item.entityId !== "string") { skipped += 1; continue; }
    try {
      await db.send(new UpdateCommand({
        TableName: table,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: "SET gsi3pk = :partition, gsi3sk = :sort",
        ConditionExpression: "assignedTechnicianId = :technician AND updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":partition": `TENANT#${tenantId}#TECHNICIAN#${item.assignedTechnicianId}`,
          ":sort": `${item.updatedAt}#${item.entityId}`,
          ":technician": item.assignedTechnicianId,
          ":updatedAt": item.updatedAt,
        },
      }));
      updated += 1;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") { skipped += 1; continue; }
      throw error;
    }
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);
process.stdout.write(JSON.stringify({ stage, tenantId, updated, skipped }) + "\n");
