import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { AuraService } from "../../aura/service";
import { createAuraHandlers } from "../handlers/aura";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("aura");
  const sfn = new SFNClient({});
  const service = new AuraService(runtime.aura(), runtime.operations(), runtime.machines(), runtime.auraWorkflow(), { succeed: async (taskToken, result) => { await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(result) })); } });
  return createAuraHandlers(service, runtime.auth);
}
function getHandlers() { return handlers ??= createHandlers(); }
export const technicians = (event: APIGatewayProxyEventV2) => getHandlers().technicians(event);
export const saveTechnician = (event: APIGatewayProxyEventV2) => getHandlers().saveTechnician(event);
export const getTechnician = (event: APIGatewayProxyEventV2) => getHandlers().getTechnician(event);
export const archiveTechnician = (event: APIGatewayProxyEventV2) => getHandlers().archiveTechnician(event);
export const putMachineCoordinates = (event: APIGatewayProxyEventV2) => getHandlers().putMachineCoordinates(event);
export const parts = (event: APIGatewayProxyEventV2) => getHandlers().parts(event);
export const createPart = (event: APIGatewayProxyEventV2) => getHandlers().createPart(event);
export const stock = (event: APIGatewayProxyEventV2) => getHandlers().stock(event);
export const inventoryAlerts = (event: APIGatewayProxyEventV2) => getHandlers().inventoryAlerts(event);
export const movements = (event: APIGatewayProxyEventV2) => getHandlers().movements(event);
export const createMovement = (event: APIGatewayProxyEventV2) => getHandlers().createMovement(event);
export const reserve = (event: APIGatewayProxyEventV2) => getHandlers().reserve(event);
export const releaseReservation = (event: APIGatewayProxyEventV2) => getHandlers().releaseReservation(event);
export const optimize = (event: APIGatewayProxyEventV2) => getHandlers().optimize(event);
export const assignments = (event: APIGatewayProxyEventV2) => getHandlers().assignments(event);
export const assignment = (event: APIGatewayProxyEventV2) => getHandlers().assignment(event);
export const assignmentResponse = (event: APIGatewayProxyEventV2) => getHandlers().assignmentResponse(event);
export const intervention = (event: APIGatewayProxyEventV2) => getHandlers().intervention(event);
export const policy = (event: APIGatewayProxyEventV2) => getHandlers().policy(event);
export const savePolicy = (event: APIGatewayProxyEventV2) => getHandlers().savePolicy(event);
export const kpis = (event: APIGatewayProxyEventV2) => getHandlers().kpis(event);
export const events = (event: APIGatewayProxyEventV2) => getHandlers().events(event);
export const workflowCapture = (input: unknown) => getHandlers().workflowCapture(input);
export const workflowNext = (input: unknown) => getHandlers().workflowNext(input);
export const workflowAccept = (input: unknown) => getHandlers().workflowAccept(input);
export const workflowClose = (input: unknown) => getHandlers().workflowClose(input);
export const workflowFail = (input: unknown) => getHandlers().workflowFail(input);
