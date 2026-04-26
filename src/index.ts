import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./utils/config.js";
import { initDb } from "./liveapi/storage.js";
import { toolDefinitions, handleToolCall } from "./liveapi/tools.js";
import { resourceDefinitions, handleResourceRead } from "./docs/resources.js";
import { indexAllModules } from "./liveapi/indexer.js";
import { searchDocs, indexAllDocs } from "./search/service.js";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

if (!existsSync(join(CONFIG.dbPath, ".."))) {
  mkdirSync(join(CONFIG.dbPath, ".."), { recursive: true });
}

initDb();

function createServer(): Server {
  const server = new Server(
    { name: CONFIG.mcpServerName, version: CONFIG.mcpServerVersion },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...toolDefinitions,
      {
        name: "searchDocs",
        description: "Semantic search through Bitrix documentation",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "searchDocs" && args) {
      const results = await searchDocs(args.query as string);
      return {
        content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
      };
    }
    return handleToolCall(name, args as Record<string, any>);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resourceDefinitions,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return handleResourceRead(request.params.uri);
  });

  return server;
}

// Session-aware MCP endpoint — one transport+server per session
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

async function getOrCreateSession(sessionId?: string): Promise<{
  transport: StreamableHTTPServerTransport;
  server: Server;
  isNew: boolean;
  sessionId: string;
}> {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    return { transport: s.transport, server: s.server, isNew: false, sessionId };
  }

  const sid = sessionId || crypto.randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sid,
    enableJsonResponse: true,
  });

  // Bypass session management — Kilo as MCP client does not send
  // initialize or mcp-session-id before tool calls. Setting stateless
  // mode on the internal WebStandard transport skips both checks.
  const webTransport = (transport as any)._webStandardTransport as any;
  webTransport._initialized = true;
  webTransport.sessionIdGenerator = undefined;

  const server = createServer();
  await server.connect(transport);
  sessions.set(sid, { server, transport });
  logger.info({ sessionId: sid }, "Session created");
  return { transport, server, isNew: true, sessionId: sid };
}

async function handleMcpRequest(req: express.Request, res: express.Response) {
  try {
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
    const { transport } = await getOrCreateSession(headerSessionId);

    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    logger.error({ err }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

const app = express();

app.use(express.json({ type: ["application/json"], limit: "4mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

let isIndexing = false;
let indexingProgress = "";

app.post("/admin/reindex", async (req, res) => {
  if (isIndexing) {
    res.json({ status: "busy", progress: indexingProgress });
    return;
  }
  isIndexing = true;
  indexingProgress = "started";
  setImmediate(async () => {
    try {
      const result = indexAllModules();
      indexingProgress = "done: " + JSON.stringify(result);
      logger.info({ result }, "Reindex completed");
    } catch (e: any) {
      indexingProgress = "error: " + e.message;
      logger.error({ err: e }, "Reindex failed");
    } finally {
      isIndexing = false;
    }
  });
  res.json({ status: "ok", message: "Reindex started in background" });
});

app.post("/admin/reindex-docs", async (req, res) => {
  if (isIndexing) {
    res.json({ status: "busy", progress: indexingProgress });
    return;
  }
  isIndexing = true;
  indexingProgress = "started";
  setImmediate(async () => {
    try {
      await indexAllDocs();
      indexingProgress = "done";
      logger.info("Docs reindex completed");
    } catch (e: any) {
      indexingProgress = "error: " + e.message;
      logger.error({ err: e }, "Docs reindex failed");
    } finally {
      isIndexing = false;
    }
  });
  res.json({ status: "ok", message: "Docs reindex started in background" });
});

app.get("/admin/progress", (req, res) => {
  res.json({ isIndexing, progress: indexingProgress });
});

app.all("/", handleMcpRequest);
app.all("/sse", handleMcpRequest);
app.all("/messages", handleMcpRequest);

const httpServer = app.listen(CONFIG.port, () => {
  logger.info("BxMCP server listening on port " + CONFIG.port);
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received");
  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
