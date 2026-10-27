import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./utils/config.js";
import { initDb, loadEmbeddingsCache } from "./liveapi/storage.js";
import { toolDefinitions, handleToolCall } from "./liveapi/tools.js";
import { resourceDefinitions, handleResourceRead } from "./docs/resources.js";
import { indexAllModules, indexAllComponents } from "./liveapi/indexer.js";
import { searchDocs, indexAllDocs, embeddingsSignature } from "./search/service.js";
import { initAnalytics, recordEvent, getStats, getTodayUsage, type Stats } from "./analytics.js";
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
initAnalytics();

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

function clientIp(req: express.Request): string | null {
  const xReal = req.headers["x-real-ip"];
  if (typeof xReal === "string" && xReal) return xReal.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

function trackMcpRequest(req: express.Request, sessionId: string): void {
  const ip = clientIp(req);
  const ua = (req.headers["user-agent"] as string) || null;
  const body = req.body;
  if (!body) return;
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    const method = m?.method;
    if (method === "initialize") {
      recordEvent({ type: "connection", ip, ua, sessionId, detail: m?.params?.clientInfo?.name });
    } else if (method === "tools/call") {
      recordEvent({ type: "tool_call", ip, ua, sessionId, tool: m?.params?.name });
    } else if (method === "resources/read") {
      recordEvent({ type: "resource_read", ip, ua, sessionId, detail: m?.params?.uri });
    }
  }
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function fmtTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderStatsHtml(s: Stats): string {
  const card = (label: string, value: string | number) =>
    `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  const dailyRows = s.daily
    .map(
      (d) =>
        `<tr><td>${esc(d.date)}</td><td>${d.connections}</td><td>${d.uniqueIps}</td><td>${d.toolCalls}</td><td>${d.resourceReads}</td></tr>`
    )
    .join("");

  const toolRows = s.topTools
    .map((t) => `<tr><td>${esc(t.tool)}</td><td>${t.count}</td></tr>`)
    .join("");

  const ipRows = s.topIps
    .map((t) => `<tr><td>${esc(t.ip)}</td><td>${t.connections}</td><td>${esc(fmtTime(t.lastSeen))}</td></tr>`)
    .join("");

  const connRows = s.recentConnections
    .map((c) => `<tr><td>${esc(fmtTime(c.ts))}</td><td>${esc(c.ip)}</td><td class="ua">${esc(c.ua)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BxMCP — статистика</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
  header{padding:20px 24px;border-bottom:1px solid #23262d}
  h1{margin:0;font-size:20px}
  .sub{color:#8b93a1;font-size:12px;margin-top:6px}
  .wrap{padding:24px;max-width:1100px;margin:0 auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#171a20;border:1px solid #23262d;border-radius:10px;padding:16px}
  .card .v{font-size:26px;font-weight:600}
  .card .l{color:#8b93a1;font-size:12px;margin-top:6px}
  h2{font-size:15px;margin:28px 0 10px;color:#c7ccd6}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#171a20;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #23262d}
  th{color:#8b93a1;font-weight:500;background:#14171c}
  tr:last-child td{border-bottom:none}
  td.ua{color:#8b93a1;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .muted{color:#8b93a1;font-size:12px}
</style></head>
<body>
<header><h1>BxMCP — статистика использования</h1>
<div class="sub">Сформировано: ${esc(fmtTime(Date.parse(s.generatedAt)))} · TZ: ${esc(s.timezone)}</div></header>
<div class="wrap">
  <div class="cards">
    ${card("Онлайн (сессии)", s.online.activeSessions)}
    ${card("IP за 15 мин", s.online.ipsLast15min)}
    ${card("Подключений всего", s.totals.connections)}
    ${card("Уникальных IP всего", s.totals.uniqueIps)}
    ${card("Вызовов инструментов", s.totals.toolCalls)}
    ${card("Сегодня подключений", s.today.connections)}
    ${card("Сегодня IP", s.today.uniqueIps)}
    ${card("Сегодня вызовов", s.today.toolCalls)}
    ${card("За 24ч подключений", s.last24h.connections)}
    ${card("За 24ч IP", s.last24h.uniqueIps)}
    ${card("За 24ч вызовов", s.last24h.toolCalls)}
  </div>

  <h2>По дням</h2>
  <table><thead><tr><th>Дата</th><th>Подключения</th><th>Уник. IP</th><th>Вызовы</th><th>Чтение ресурсов</th></tr></thead>
  <tbody>${dailyRows || '<tr><td colspan="5" class="muted">нет данных</td></tr>'}</tbody></table>

  <h2>Топ инструментов</h2>
  <table><thead><tr><th>Инструмент</th><th>Вызовов</th></tr></thead>
  <tbody>${toolRows || '<tr><td colspan="2" class="muted">нет данных</td></tr>'}</tbody></table>

  <h2>Топ IP</h2>
  <table><thead><tr><th>IP</th><th>Подключений</th><th>Последний раз</th></tr></thead>
  <tbody>${ipRows || '<tr><td colspan="3" class="muted">нет данных</td></tr>'}</tbody></table>

  <h2>Последние подключения</h2>
  <table><thead><tr><th>Время</th><th>IP</th><th>User-Agent</th></tr></thead>
  <tbody>${connRows || '<tr><td colspan="3" class="muted">нет данных</td></tr>'}</tbody></table>

  <p class="muted" style="margin-top:24px">JSON: <a href="?format=json" style="color:#6ea8fe">?format=json</a></p>
</div></body></html>`;
}

async function handleMcpRequest(req: express.Request, res: express.Response) {
  try {
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
    const isStateless = !headerSessionId;
    const sid = headerSessionId || crypto.randomUUID();

    trackMcpRequest(req, sid);

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
  res.json({
    status: "ok",
    uptime: process.uptime(),
    version: CONFIG.mcpServerVersion,
    embeddings: {
      url: CONFIG.embeddingsUrl,
      model: CONFIG.embeddingModel,
      dim: CONFIG.embeddingDim,
      signature: embeddingsSignature(),
    },
  });
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
      const result = await indexAllDocs((current, total, embedded) => {
        indexingProgress = `docs ${current}/${total} (embedded ${embedded})`;
      });
      indexingProgress = `done: ${JSON.stringify(result)}`;
      logger.info(result, "Docs reindex completed");
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

app.get("/admin/usage", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Access-Control-Allow-Origin", "*");
  res.json(getTodayUsage());
});

app.get("/admin/stats", (req, res) => {
  const token = process.env.STATS_TOKEN;
  if (token) {
    const provided = (req.query.token as string) || (req.headers["x-stats-token"] as string);
    if (provided !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  const rawDays = parseInt((req.query.days as string) || "14", 10);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 14, 1), 90);
  const stats = getStats(days, sessions.size);
  if ((req.query.format as string) === "html") {
    res.type("html").send(renderStatsHtml(stats));
    return;
  }
  res.json(stats);
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
