import Database from "better-sqlite3";
import { dirname, join } from "path";
import { CONFIG } from "./utils/config.js";

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;

function analyticsDbPath(): string {
  return (
    process.env.ANALYTICS_DB_PATH ||
    join(dirname(CONFIG.dbPath), "analytics.db")
  );
}

function ensureDb(): Database.Database {
  if (db && insertStmt) return db;
  db = new Database(analyticsDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      ip TEXT,
      ua TEXT,
      session_id TEXT,
      tool TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
    CREATE INDEX IF NOT EXISTS idx_events_ip ON events(ip);
  `);
  insertStmt = db.prepare(
    "INSERT INTO events (ts, type, ip, ua, session_id, tool, detail) VALUES (@ts, @type, @ip, @ua, @session_id, @tool, @detail)"
  );
  return db;
}

export function initAnalytics(): void {
  try {
    ensureDb();
  } catch {
    // analytics must never prevent the server from starting
  }
}

export type AnalyticsEventType = "connection" | "tool_call" | "resource_read";

export function recordEvent(ev: {
  type: AnalyticsEventType;
  ip?: string | null;
  ua?: string | null;
  sessionId?: string | null;
  tool?: string | null;
  detail?: string | null;
}): void {
  try {
    ensureDb();
    insertStmt!.run({
      ts: Date.now(),
      type: ev.type,
      ip: ev.ip ?? null,
      ua: ev.ua ?? null,
      session_id: ev.sessionId ?? null,
      tool: ev.tool ?? null,
      detail: ev.detail ?? null,
    });
  } catch {
    // swallow — analytics is best-effort
  }
}

export interface PeriodStats {
  connections: number;
  uniqueIps: number;
  toolCalls: number;
  resourceReads: number;
}

export interface DailyStats extends PeriodStats {
  date: string;
}

export interface Stats {
  generatedAt: string;
  timezone: string;
  totals: PeriodStats;
  last24h: PeriodStats;
  today: DailyStats;
  online: { activeSessions: number; ipsLast15min: number };
  daily: DailyStats[];
  topTools: Array<{ tool: string; count: number }>;
  topIps: Array<{ ip: string | null; connections: number; lastSeen: number }>;
  recentConnections: Array<{ ts: number; ip: string | null; ua: string | null }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Москва — фиксированный UTC+3 (перехода на летнее время нет с 2014 года).
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function periodStats(where: string, params: any[]): PeriodStats {
  const d = ensureDb();
  const row = d
    .prepare(
      `SELECT
         SUM(CASE WHEN type = 'connection' THEN 1 ELSE 0 END) AS connections,
         SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) AS toolCalls,
         SUM(CASE WHEN type = 'resource_read' THEN 1 ELSE 0 END) AS resourceReads,
         COUNT(DISTINCT CASE WHEN type = 'connection' THEN ip END) AS uniqueIps
       FROM events ${where}`
    )
    .get(...params) as any;
  return {
    connections: Number(row?.connections || 0),
    uniqueIps: Number(row?.uniqueIps || 0),
    toolCalls: Number(row?.toolCalls || 0),
    resourceReads: Number(row?.resourceReads || 0),
  };
}

function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Дата по Москве (Europe/Moscow / UTC+3) независимо от таймзоны ОС.
function mskDateStr(ms: number | Date): string {
  const d = ms instanceof Date ? ms : new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const msk = new Date(d.getTime() + MSK_OFFSET_MS);
  return `${msk.getUTCFullYear()}-${p(msk.getUTCMonth() + 1)}-${p(msk.getUTCDate())}`;
}

// Начало текущих московских суток (00:00:00.000 MSK) в epoch-мс.
function startOfMskDayMs(now: Date = new Date()): number {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - MSK_OFFSET_MS;
}

export interface UsageToday {
  date: string;
  timezone: string;
  uses: number;
  users: number;
  toolCalls: number;
  resourceReads: number;
}

// "Воспользовались сегодня" = число ИСПОЛЬЗОВАНИЙ (tools/call + resources/read)
// с 00:00:00.000 по московскому времени. Каждый вызов считается отдельно:
// один и тот же IP может дать сколько угодно использований. Подключение
// клиента (initialize) использованием НЕ считается.
export function getTodayUsage(): UsageToday {
  const d = ensureDb();
  const startMs = startOfMskDayMs();
  const row = d
    .prepare(
      `SELECT
         SUM(CASE WHEN type IN ('tool_call', 'resource_read') THEN 1 ELSE 0 END) AS uses,
         COUNT(DISTINCT CASE WHEN type IN ('tool_call', 'resource_read') THEN ip END) AS users,
         SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) AS toolCalls,
         SUM(CASE WHEN type = 'resource_read' THEN 1 ELSE 0 END) AS resourceReads
       FROM events WHERE ts >= ?`
    )
    .get(startMs) as any;
  return {
    date: mskDateStr(Date.now()),
    timezone: "Europe/Moscow",
    uses: Number(row?.uses || 0),
    users: Number(row?.users || 0),
    toolCalls: Number(row?.toolCalls || 0),
    resourceReads: Number(row?.resourceReads || 0),
  };
}

export function getStats(days = 14, activeSessions = 0): Stats {
  const d = ensureDb();
  const now = new Date();
  const todayStr = mskDateStr(now);
  const since = Date.now() - days * DAY_MS;

  const dailyRows = d
    .prepare(
      `SELECT date(ts/1000 + 10800, 'unixepoch') AS date,
              SUM(CASE WHEN type = 'connection' THEN 1 ELSE 0 END) AS connections,
              SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) AS toolCalls,
              SUM(CASE WHEN type = 'resource_read' THEN 1 ELSE 0 END) AS resourceReads,
              COUNT(DISTINCT CASE WHEN type = 'connection' THEN ip END) AS uniqueIps
       FROM events
       WHERE ts >= ?
       GROUP BY date`
    )
    .all(since) as any[];

  const byDate = new Map<string, any>();
  for (const r of dailyRows) byDate.set(r.date, r);

  const daily: DailyStats[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(now.getTime() - i * DAY_MS);
    const key = mskDateStr(dt);
    const r = byDate.get(key);
    daily.push({
      date: key,
      connections: Number(r?.connections || 0),
      uniqueIps: Number(r?.uniqueIps || 0),
      toolCalls: Number(r?.toolCalls || 0),
      resourceReads: Number(r?.resourceReads || 0),
    });
  }

  const today = daily.find((x) => x.date === todayStr) || {
    date: todayStr,
    connections: 0,
    uniqueIps: 0,
    toolCalls: 0,
    resourceReads: 0,
  };

  const topTools = (
    d
      .prepare(
        `SELECT tool, COUNT(*) AS count
         FROM events WHERE type = 'tool_call' AND tool IS NOT NULL
         GROUP BY tool ORDER BY count DESC LIMIT 15`
      )
      .all() as any[]
  ).map((r) => ({ tool: String(r.tool), count: Number(r.count) }));

  const topIps = (
    d
      .prepare(
        `SELECT ip,
                SUM(CASE WHEN type = 'connection' THEN 1 ELSE 0 END) AS connections,
                MAX(ts) AS lastSeen
         FROM events WHERE ip IS NOT NULL
         GROUP BY ip ORDER BY connections DESC, lastSeen DESC LIMIT 15`
      )
      .all() as any[]
  ).map((r) => ({
    ip: r.ip as string | null,
    connections: Number(r.connections || 0),
    lastSeen: Number(r.lastSeen || 0),
  }));

  const recentConnections = (
    d
      .prepare(
        `SELECT ts, ip, ua FROM events
         WHERE type = 'connection' ORDER BY id DESC LIMIT 25`
      )
      .all() as any[]
  ).map((r) => ({ ts: Number(r.ts), ip: r.ip ?? null, ua: r.ua ?? null }));

  const ipsLast15min = Number(
    (
      d
        .prepare(
          `SELECT COUNT(DISTINCT ip) AS c FROM events
           WHERE type = 'connection' AND ts >= ?`
        )
        .get(Date.now() - 15 * 60 * 1000) as any
    )?.c || 0
  );

  return {
    generatedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    totals: periodStats("", []),
    last24h: periodStats("WHERE ts >= ?", [Date.now() - DAY_MS]),
    today,
    online: { activeSessions, ipsLast15min },
    daily,
    topTools,
    topIps,
    recentConnections,
  };
}
