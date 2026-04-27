import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./utils/config.js";
import { initDb, loadEmbeddingsCache } from "./liveapi/storage.js";
import { toolDefinitions, handleToolCall } from "./liveapi/tools.js";
import { resourceDefinitions, handleResourceRead } from "./docs/resources.js";
import { indexAllModules, indexAllComponents } from "./liveapi/indexer.js";
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
loadEmbeddingsCache();

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

// Session-aware MCP endpoint — stateful sessions cached, stateless per-request
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

async function handleMcpRequest(req: express.Request, res: express.Response) {
  try {
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
    const isStateless = !headerSessionId;
    const sid = headerSessionId || crypto.randomUUID();

    let transport: StreamableHTTPServerTransport;
    let server: Server;
    let isNew = false;

    if (isStateless) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      server = createServer();
      await server.connect(transport);
    } else if (sessions.has(sid)) {
      const cached = sessions.get(sid)!;
      transport = cached.transport;
      server = cached.server;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sid,
        enableJsonResponse: true,
      });
      server = createServer();
      await server.connect(transport);
      sessions.set(sid, { server, transport });
      isNew = true;
      logger.info({ sessionId: sid }, "Stateful session created");

      // Auto-initialize if the client skipped initialize
      if (req.body && req.body.method !== "initialize") {
        const initBody = {
          jsonrpc: "2.0" as const,
          method: "initialize" as const,
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bxmcp", version: "1.0" } },
          id: 0,
        };
        const origJson = res.json.bind(res);
        const origEnd = res.end.bind(res);
        const origWriteHead = res.writeHead.bind(res);
        const origWrite = res.write.bind(res);
        const origStatus = res.status.bind(res);

        let initDone = false;
        const swallow = () => { if (!initDone) { initDone = true; return res; } return res; };

        res.json = ((data: any) => swallow()) as any;
        res.end = ((data?: any) => swallow()) as any;
        res.writeHead = ((code: number) => swallow()) as any;
        res.write = ((chunk: any) => swallow()) as any;
        res.status = ((code: number) => swallow()) as any;

        await transport.handleRequest(req, res, initBody);

        res.json = origJson;
        res.end = origEnd;
        res.writeHead = origWriteHead;
        res.write = origWrite;
        res.status = origStatus;
      }
    }

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
      const modules = indexAllModules();
      const components = indexAllComponents();
      const result = { ...modules, ...components };
      indexingProgress = "done: " + JSON.stringify(result);
      logger.info({ result }, "Full reindex completed");
    } catch (e: any) {
      indexingProgress = "error: " + e.message;
      logger.error({ err: e }, "Full reindex failed");
    } finally {
      isIndexing = false;
    }
  });
  res.json({ status: "ok", message: "Full reindex (modules + components) started in background" });
});

app.post("/admin/reindex-components", async (req, res) => {
  if (isIndexing) {
    res.json({ status: "busy", progress: indexingProgress });
    return;
  }
  isIndexing = true;
  indexingProgress = "started";
  setImmediate(async () => {
    try {
      const result = indexAllComponents();
      indexingProgress = "done: " + JSON.stringify(result);
      logger.info({ result }, "Components reindex completed");
    } catch (e: any) {
      indexingProgress = "error: " + e.message;
      logger.error({ err: e }, "Components reindex failed");
    } finally {
      isIndexing = false;
    }
  });
  res.json({ status: "ok", message: "Components reindex started in background" });
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
