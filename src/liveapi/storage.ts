import Database from "better-sqlite3";
import { CONFIG } from "../utils/config.js";
import type { ParsedFunction, ParsedClass, ParsedEvent, ParsedConstant } from "../utils/php-parser.js";

let db: Database.Database;

export function initDb(): void {
  db = new Database(CONFIG.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      name TEXT,
      version TEXT,
      path TEXT,
      indexed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      phpdoc TEXT,
      code TEXT,
      args TEXT,
      is_method INTEGER DEFAULT 0,
      class_name TEXT,
      visibility TEXT DEFAULT 'public'
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      fired_in_function TEXT
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      type TEXT,
      extends TEXT,
      implements TEXT,
      phpdoc TEXT
    );

    CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
    CREATE INDEX IF NOT EXISTS idx_functions_module ON functions(module_id);
    CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
    CREATE INDEX IF NOT EXISTS idx_events_module ON events(module_id);
  `);
}

export function getDb(): Database.Database {
  if (!db) initDb();
  return db;
}

export function upsertModule(id: string, name: string, path: string, version: string = ""): void {
  getDb().prepare(
    "INSERT OR REPLACE INTO modules (id, name, version, path, indexed_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(id, name, version, path);
}

export function insertFunction(fn: ParsedFunction & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO functions (name, module_id, file_path, line_number, phpdoc, code, args, is_method, class_name, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fn.name, fn.moduleId, fn.filePath, fn.lineNumber,
    fn.phpdoc, fn.code, JSON.stringify(fn.args),
    fn.isMethod ? 1 : 0, fn.className || null, fn.visibility
  );
}

export function insertClass(cls: ParsedClass & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO classes (name, module_id, file_path, line_number, type, extends, implements, phpdoc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    cls.name, cls.moduleId, cls.filePath, cls.lineNumber,
    cls.type, JSON.stringify(cls.extends), JSON.stringify(cls.implements), cls.phpdoc
  );
}

export function insertEvent(evt: ParsedEvent & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO events (name, module_id, file_path, line_number, fired_in_function)
     VALUES (?, ?, ?, ?, ?)`
  ).run(evt.name, evt.moduleId, evt.filePath, evt.lineNumber, evt.firedInFunction);
}

export function clearModuleData(moduleId: string): void {
  getDb().prepare("DELETE FROM functions WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM classes WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM events WHERE module_id = ?").run(moduleId);
}

export function listModules(): { id: string; name: string; version: string }[] {
  return getDb().prepare("SELECT id, name, version FROM modules ORDER BY name").all() as any[];
}

export function getModuleFunctions(moduleId: string, limit: number, offset: number): { functions: any[]; total: number } {
  const total = (getDb().prepare("SELECT COUNT(*) as cnt FROM functions WHERE module_id = ?").get(moduleId) as any).cnt;
  const functions = getDb().prepare(
    "SELECT id, name, line_number as lineNumber, file_path as filePath, args, is_method as isMethod, class_name as className FROM functions WHERE module_id = ? ORDER BY name LIMIT ? OFFSET ?"
  ).all(moduleId, limit, offset);
  return { functions, total };
}

export function getModuleEvents(moduleId: string): any[] {
  return getDb().prepare(
    "SELECT name, file_path as filePath, line_number as lineNumber, fired_in_function as firedInFunc FROM events WHERE module_id = ? ORDER BY name"
  ).all(moduleId);
}

export function findFunction(name: string, moduleId?: string): any[] {
  if (moduleId) {
    return getDb().prepare(
      "SELECT name, module_id as moduleId, file_path as filePath, line_number as lineNumber FROM functions WHERE name LIKE ? AND module_id = ? ORDER BY name LIMIT 50"
    ).all(`%${name}%`, moduleId);
  }
  return getDb().prepare(
    "SELECT name, module_id as moduleId, file_path as filePath, line_number as lineNumber FROM functions WHERE name LIKE ? ORDER BY name LIMIT 50"
  ).all(`%${name}%`);
}

export function findFunctionExact(name: string): any[] {
  return getDb().prepare(
    "SELECT name, module_id as moduleId, file_path as filePath, line_number as lineNumber FROM functions WHERE name = ? ORDER BY name LIMIT 50"
  ).all(name);
}

export function getFunctionCode(name: string, moduleId: string): string | null {
  const row = getDb().prepare(
    "SELECT phpdoc, code, file_path as filePath, line_number as lineNumber FROM functions WHERE name = ? AND module_id = ? LIMIT 1"
  ).get(name, moduleId) as any;
  if (!row) return null;
  return `${row.phpdoc || ""}\n// File: ${row.filePath}:${row.lineNumber}\n${row.code || ""}`;
}

export function insertDocChunk(filePath: string, chunkIndex: number, content: string, embedding: Buffer | null): void {
  getDb().prepare(
    "INSERT INTO doc_chunks (file_path, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
  ).run(filePath, chunkIndex, content, embedding);
}

export function clearDocChunks(): void {
  getDb().prepare("DELETE FROM doc_chunks").run();
}

export function searchDocChunks(queryEmbedding: Float32Array, limit: number = 10): any[] {
  const rows = getDb().prepare(
    "SELECT id, file_path as filePath, chunk_index as chunkIndex, content, embedding FROM doc_chunks WHERE embedding IS NOT NULL"
  ).all() as any[];

  const scored = rows.map((row: any) => {
    const emb = new Float32Array(new Uint8Array(row.embedding).buffer);
    const score = cosineSimilarity(queryEmbedding, emb);
    return { filePath: row.filePath, chunkIndex: row.chunkIndex, text: row.content, score };
  });

  scored.sort((a: any, b: any) => b.score - a.score);
  return scored.slice(0, limit);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
