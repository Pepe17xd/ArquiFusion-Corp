import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createApiHandlers, type ApiServices } from "./api/handlers";
import { MAX_IMPORT_BYTES } from "./ingestion/service";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const allowedMethods = "GET,POST,OPTIONS";

export function createLocalServer(services?: ApiServices): Server {
  const handlers = createApiHandlers(services);
  return createServer(async (request, response) => {
    const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
    if (request.headers.origin === allowedOrigin) response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", allowedMethods);
    response.setHeader("access-control-allow-headers", "content-type,authorization,x-tenant-id,idempotency-key,x-correlation-id");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = resolveRoute(request.method ?? "GET", url.pathname, handlers);
    if (!route) { sendJson(response, 404, { data: { error: "Route not found" } }); return; }
    try {
      const body = await readBody(request);
      const event = {
        version: "2.0",
        routeKey: request.method + " " + url.pathname,
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: request.headers as Record<string, string>,
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
        pathParameters: route.machineId ? { machineId: route.machineId } : route.taskId ? { taskId: route.taskId } : undefined,
        requestContext: {
          accountId: "local", apiId: "local", domainName: "localhost", domainPrefix: "localhost",
          http: { method: request.method ?? "GET", path: url.pathname, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: request.headers["user-agent"] ?? "local" },
          requestId: randomUUID(), routeKey: request.method + " " + url.pathname, stage: "$default", time: new Date().toISOString(), timeEpoch: Date.now(),
        },
        body: body || undefined,
        isBase64Encoded: false,
      } as Parameters<typeof route.handler>[0];
      const result = await route.handler(event);
      const statusCode = typeof result === "object" && result !== null && "statusCode" in result ? result.statusCode : 200;
      const headers = typeof result === "object" && result !== null && "headers" in result ? result.headers : {};
      const resultBody = typeof result === "object" && result !== null && "body" in result ? result.body : JSON.stringify(result);
      response.writeHead(Number(statusCode), headers as Record<string, string>).end(resultBody as string | undefined);
    } catch (error) {
      const statusCode = error instanceof Error && error.message === "Request body exceeds the 8 MB limit" ? 413 : 400;
      sendJson(response, statusCode, { data: { error: statusCode === 413 ? "Payload too large" : "Invalid request" } });
    }
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_IMPORT_BYTES) throw new Error("Request body exceeds the 8 MB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type HandlerSet = ReturnType<typeof createApiHandlers>;
type LocalHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
function resolveRoute(method: string, pathname: string, handlers: HandlerSet): { handler: LocalHandler; machineId?: string; taskId?: string } | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (method === "GET" && path === "/health") return { handler: handlers.health as LocalHandler };
  if (method === "POST" && path === "/ingest/csv") return { handler: handlers.ingestCsv as LocalHandler };
  if (method === "POST" && path === "/ingest/json") return { handler: handlers.ingestJson as LocalHandler };
  if (method === "GET" && path === "/machines") return { handler: handlers.listMachines as LocalHandler };
  if (method === "GET" && path === "/metrics") return { handler: handlers.metrics as LocalHandler };
  if (method === "GET" && path === "/intelligence/recommendations") return { handler: handlers.intelligence as LocalHandler };
  if (method === "GET" && path === "/agents") return { handler: handlers.agents as LocalHandler };
  if (method === "GET" && path === "/tenants") return { handler: handlers.listTenants as LocalHandler };
  if (method === "POST" && path === "/tenants") return { handler: handlers.createTenant as LocalHandler };
  if (method === "POST" && path === "/tasks") return { handler: handlers.submitTask as LocalHandler };
  if (method === "GET" && path === "/tasks") return { handler: handlers.tasks as LocalHandler };
  if (method === "GET" && path === "/events") return { handler: handlers.taskEvents as LocalHandler };
  if (method === "GET" && path === "/operations/overview") return { handler: handlers.operationsOverview as LocalHandler };
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
  if (method === "GET" && taskMatch) return { handler: handlers.getTask as LocalHandler, taskId: taskMatch[1] };
  const machineMatch = /^\/machines\/(.+)$/.exec(path);
  if (method === "GET" && machineMatch) return { handler: handlers.getMachine as LocalHandler, machineId: machineMatch[1] };
  return undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3001);
  createLocalServer().listen(port, "127.0.0.1", () => process.stdout.write("ArquiFusion API listening on http://127.0.0.1:" + port + "\n"));
}
