import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CONFIG } from "../utils/config.js";
import type { ParsedFunction, ParsedClass, ParsedEvent, ParsedConstant, FunctionUsage } from "../utils/php-parser.js";

let db: Database.Database;

const EMBEDDING_DIM = CONFIG.embeddingDim;
let embeddingsCache: Float32Array | null = null;
let embeddingsMetadata: { filePath: string; chunkIndex: number; text: string }[] = [];
let skippedEmbeddings = 0;

export function loadEmbeddingsCache(): void {
  const rows = getDb().prepare(
    "SELECT file_path, chunk_index, content, embedding FROM doc_chunks WHERE embedding IS NOT NULL ORDER BY id"
  ).all() as any[];

  if (rows.length === 0) {
    embeddingsCache = null;
    embeddingsMetadata = [];
    return;
  }

  const expectedBytes = EMBEDDING_DIM * 4;
  const usable = rows.filter((row: any) => row.embedding && row.embedding.length === expectedBytes);
  skippedEmbeddings = rows.length - usable.length;
  if (skippedEmbeddings > 0) {
    console.warn(
      `[storage] ${skippedEmbeddings} doc chunk embeddings skipped: expected ${expectedBytes} bytes, ` +
        `found other sizes. Run POST /admin/reindex-docs to rebuild.`
    );
  }

  const totalFloats = usable.length * EMBEDDING_DIM;
  embeddingsCache = new Float32Array(totalFloats);
  embeddingsMetadata = new Array(usable.length);

  for (let i = 0; i < usable.length; i++) {
    const row = usable[i];
    const emb = new Float32Array(new Uint8Array(row.embedding).buffer);
    embeddingsCache.set(emb, i * EMBEDDING_DIM);
    embeddingsMetadata[i] = {
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      text: row.content,
    };
  }
}

export function getSkippedEmbeddings(): number {
  return skippedEmbeddings;
}

function invalidateEmbeddingsCache(): void {
  embeddingsCache = null;
  embeddingsMetadata = [];
}

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
      full_name TEXT,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      phpdoc TEXT,
      code TEXT,
      args TEXT,
      is_method INTEGER DEFAULT 0,
      class_name TEXT,
      visibility TEXT DEFAULT 'public',
      namespace TEXT DEFAULT ''
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
      full_name TEXT,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      type TEXT,
      extends TEXT,
      implements TEXT,
      phpdoc TEXT,
      namespace TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_doc_chunks_path ON doc_chunks (file_path, chunk_index);

    CREATE TABLE IF NOT EXISTS class_constants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      full_name TEXT,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      visibility TEXT DEFAULT 'public',
      class_name TEXT,
      namespace TEXT DEFAULT '',
      value TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS function_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      function_name TEXT NOT NULL,
      full_name TEXT,
      module_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      context TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
    CREATE INDEX IF NOT EXISTS idx_functions_full_name ON functions(full_name);
    CREATE INDEX IF NOT EXISTS idx_functions_module ON functions(module_id);
    CREATE INDEX IF NOT EXISTS idx_functions_namespace ON functions(namespace);
    CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_classes_full_name ON classes(full_name);
    CREATE INDEX IF NOT EXISTS idx_classes_namespace ON classes(namespace);
    CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
    CREATE INDEX IF NOT EXISTS idx_events_module ON events(module_id);
    CREATE INDEX IF NOT EXISTS idx_constants_class ON class_constants(class_name);
    CREATE INDEX IF NOT EXISTS idx_constants_module ON class_constants(module_id);
    CREATE INDEX IF NOT EXISTS idx_usages_name ON function_usages(function_name);
    CREATE INDEX IF NOT EXISTS idx_usages_module ON function_usages(module_id);
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
    `INSERT INTO functions (name, full_name, module_id, file_path, line_number, phpdoc, code, args, is_method, class_name, visibility, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fn.name, fn.fullName, fn.moduleId, fn.filePath, fn.lineNumber,
    fn.phpdoc, fn.code, JSON.stringify(fn.args),
    fn.isMethod ? 1 : 0, fn.className || null, fn.visibility, fn.namespace || ""
  );
}

export function insertClass(cls: ParsedClass & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO classes (name, full_name, module_id, file_path, line_number, type, extends, implements, phpdoc, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    cls.name, cls.fullName, cls.moduleId, cls.filePath, cls.lineNumber,
    cls.type, JSON.stringify(cls.extends), JSON.stringify(cls.implements), cls.phpdoc, cls.namespace || ""
  );
}

export function insertEvent(evt: ParsedEvent & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO events (name, module_id, file_path, line_number, fired_in_function)
     VALUES (?, ?, ?, ?, ?)`
  ).run(evt.name, evt.moduleId, evt.filePath, evt.lineNumber, evt.firedInFunction);
}

export function insertClassConstant(c: ParsedConstant & { moduleId: string; filePath: string }): void {
  getDb().prepare(
    `INSERT INTO class_constants (name, full_name, module_id, file_path, line_number, visibility, class_name, namespace, value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(c.name, c.fullName, c.moduleId, c.filePath, c.lineNumber, c.visibility || "public", c.className || null, c.namespace || "", c.value || "");
}

export function insertFunctionUsage(u: FunctionUsage & { moduleId: string }): void {
  getDb().prepare(
    `INSERT INTO function_usages (function_name, full_name, module_id, file_path, line_number, context)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(u.functionName, u.functionName, u.moduleId, u.filePath, u.lineNumber, u.context || null);
}

export function clearModuleData(moduleId: string): void {
  getDb().prepare("DELETE FROM functions WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM classes WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM events WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM class_constants WHERE module_id = ?").run(moduleId);
  getDb().prepare("DELETE FROM function_usages WHERE module_id = ?").run(moduleId);
}

export function listModules(): { id: string; name: string; version: string }[] {
  return getDb().prepare("SELECT id, name, version FROM modules WHERE id NOT LIKE 'comp:%' ORDER BY name").all() as any[];
}

export function listComponents(): { id: string; name: string; version: string; path: string }[] {
  return getDb().prepare("SELECT id, name, version, path FROM modules WHERE id LIKE 'comp:%' ORDER BY name").all() as any[];
}

export function getModuleFunctions(moduleId: string, limit: number, offset: number): { functions: any[]; total: number } {
  const total = (getDb().prepare("SELECT COUNT(*) as cnt FROM functions WHERE module_id = ?").get(moduleId) as any).cnt;
  const functions = getDb().prepare(
    `SELECT id, name, full_name as fullName, line_number as lineNumber, file_path as filePath, args,
            is_method as isMethod, class_name as className, visibility, namespace
     FROM functions WHERE module_id = ? ORDER BY name LIMIT ? OFFSET ?`
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
      `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
              line_number as lineNumber, is_method as isMethod, class_name as className, namespace
       FROM functions WHERE (name LIKE ? OR full_name LIKE ?) AND module_id = ? ORDER BY name LIMIT 50`
    ).all(`%${name}%`, `%${name}%`, moduleId);
  }
  return getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, is_method as isMethod, class_name as className, namespace
     FROM functions WHERE name LIKE ? OR full_name LIKE ? ORDER BY name LIMIT 50`
  ).all(`%${name}%`, `%${name}%`);
}

export function findFunctionExact(name: string): any[] {
  return getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, is_method as isMethod, class_name as className, namespace
     FROM functions WHERE name = ? OR full_name = ? ORDER BY name LIMIT 50`
  ).all(name, name);
}

export function findByNamespace(namespace: string): { classes: any[]; functions: any[] } {
  const ns = namespace.endsWith("\\") ? namespace : namespace + "\\";
  const classes = getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath, line_number as lineNumber, type
     FROM classes WHERE namespace = ? OR full_name = ? ORDER BY name LIMIT 50`
  ).all(namespace, namespace);
  const functions = getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath, line_number as lineNumber,
            is_method as isMethod, class_name as className, visibility, namespace
     FROM functions WHERE namespace = ? OR full_name LIKE ? ORDER BY name LIMIT 100`
  ).all(namespace, ns + "%");
  return { classes, functions };
}

export function getClasses(moduleId: string, limit: number, offset: number): { classes: any[]; total: number } {
  const total = (getDb().prepare("SELECT COUNT(*) as cnt FROM classes WHERE module_id = ?").get(moduleId) as any).cnt;
  const classes = getDb().prepare(
    `SELECT id, name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, type, extends, implements, namespace
     FROM classes WHERE module_id = ? ORDER BY name LIMIT ? OFFSET ?`
  ).all(moduleId, limit, offset);
  return { classes, total };
}

export function getFunctionCode(name: string, moduleId: string): string | null {
  const row = getDb().prepare(
    "SELECT phpdoc, code, file_path as filePath, line_number as lineNumber FROM functions WHERE name = ? AND module_id = ? LIMIT 1"
  ).get(name, moduleId) as any;
  if (!row) return null;
  return `${row.phpdoc || ""}\n// File: ${row.filePath}:${row.lineNumber}\n${row.code || ""}`;
}

export function getClassCode(className: string, moduleId: string): string | null {
  const row = getDb().prepare(
    "SELECT phpdoc, file_path as filePath, line_number as lineNumber FROM classes WHERE name = ? AND module_id = ? LIMIT 1"
  ).get(className, moduleId) as any;
  if (!row) return null;
  return `${row.phpdoc || ""}\n// File: ${row.filePath}:${row.lineNumber}`;
}

export function getClassMethods(className: string, moduleId: string): any[] {
  return getDb().prepare(
    `SELECT name, full_name as fullName, line_number as lineNumber, phpdoc, args, visibility, namespace
     FROM functions WHERE class_name = ? AND module_id = ? ORDER BY lineNumber`
  ).all(className, moduleId);
}

export function getClassConstants(className: string, moduleId: string): any[] {
  return getDb().prepare(
    `SELECT name, full_name as fullName, line_number as lineNumber, visibility, class_name as className, namespace, file_path as filePath, value
     FROM class_constants WHERE class_name = ? AND module_id = ? ORDER BY name`
  ).all(className, moduleId);
}

export function getClassConstantValue(className: string, moduleId: string, constantName: string): any {
  return getDb().prepare(
    `SELECT name, full_name as fullName, line_number as lineNumber, visibility, class_name as className, namespace, file_path as filePath, value
     FROM class_constants WHERE class_name = ? AND module_id = ? AND name = ? LIMIT 1`
  ).get(className, moduleId, constantName) as any;
}

export function getFunctionUsage(functionName: string, moduleId?: string): any[] {
  if (moduleId) {
    return getDb().prepare(
      `SELECT function_name as functionName, module_id as moduleId, file_path as filePath, line_number as lineNumber, context
       FROM function_usages WHERE function_name = ? AND module_id = ? ORDER BY file_path, line_number LIMIT 200`
    ).all(functionName, moduleId);
  }
  return getDb().prepare(
    `SELECT function_name as functionName, module_id as moduleId, file_path as filePath, line_number as lineNumber, context
     FROM function_usages WHERE function_name = ? ORDER BY module_id, file_path, line_number LIMIT 200`
  ).all(functionName);
}

export function getModuleStructure(moduleId: string): any {
  const dir = getDb().prepare("SELECT path FROM modules WHERE id = ?").get(moduleId) as any;
  if (!dir) return null;
  return { moduleId, path: dir.path };
}

export function getClassHierarchy(className: string, moduleId: string): any {
  const row = getDb().prepare(
    "SELECT name, full_name as fullName, type, extends, implements, module_id as moduleId FROM classes WHERE name = ? AND module_id = ? LIMIT 1"
  ).get(className, moduleId) as any;
  if (!row) return null;
  return { ...row, extends: JSON.parse(row.extends || "[]"), implements: JSON.parse(row.implements || "[]") };
}

export function findByInterface(interfaceName: string): any[] {
  return getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath, line_number as lineNumber, type
     FROM classes WHERE implements LIKE ? ORDER BY name LIMIT 50`
  ).all(`%${interfaceName}%`);
}

export function getModuleDependencies(moduleId: string): any[] {
  return [];
}

export function getAllEventHandlers(): any[] {
  return getDb().prepare(
    "SELECT name, module_id as moduleId, file_path as filePath, line_number as lineNumber, fired_in_function as firedInFunc FROM events ORDER BY name LIMIT 200"
  ).all();
}

export function getDocResource(docPath: string): string | null {
  try {
    const fullPath = join(CONFIG.docsPath, docPath);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, "utf-8");
  } catch { return null; }
}

export function insertDocChunk(filePath: string, chunkIndex: number, content: string, embedding: Buffer | null): void {
  getDb().prepare(
    "INSERT INTO doc_chunks (file_path, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
  ).run(filePath, chunkIndex, content, embedding);
  invalidateEmbeddingsCache();
}

export function clearDocChunks(): void {
  getDb().prepare("DELETE FROM doc_chunks").run();
  invalidateEmbeddingsCache();
}

export function getDocChunkContents(): Map<string, string> {
  const rows = getDb().prepare("SELECT file_path, chunk_index, content FROM doc_chunks").all() as any[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(chunkKey(row.file_path, row.chunk_index), row.content);
  }
  return map;
}

export function replaceDocChunk(filePath: string, chunkIndex: number, content: string, embedding: Buffer | null): void {
  const db = getDb();
  db.prepare("DELETE FROM doc_chunks WHERE file_path = ? AND chunk_index = ?").run(filePath, chunkIndex);
  db.prepare(
    "INSERT INTO doc_chunks (file_path, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
  ).run(filePath, chunkIndex, content, embedding);
  invalidateEmbeddingsCache();
}

export function deleteDocChunk(filePath: string, chunkIndex: number): void {
  getDb().prepare("DELETE FROM doc_chunks WHERE file_path = ? AND chunk_index = ?").run(filePath, chunkIndex);
  invalidateEmbeddingsCache();
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function chunkKey(filePath: string, chunkIndex: number): string {
  return filePath + "\u0000" + chunkIndex;
}

export function searchDocChunks(queryEmbedding: Float32Array, limit: number = 10): any[] {
  if (!embeddingsCache || embeddingsMetadata.length === 0) {
    return fallbackDiskSearch(queryEmbedding, limit);
  }

  const dim = EMBEDDING_DIM;
  const n = embeddingsMetadata.length;
  const scores: { index: number; score: number }[] = new Array(n);

  for (let i = 0; i < n; i++) {
    let dot = 0;
    const offset = i * dim;
    for (let j = 0; j < dim; j++) {
      dot += queryEmbedding[j] * embeddingsCache[offset + j];
    }
    scores[i] = { index: i, score: dot };
  }

  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, limit).map(s => ({
    filePath: embeddingsMetadata[s.index].filePath,
    chunkIndex: embeddingsMetadata[s.index].chunkIndex,
    text: embeddingsMetadata[s.index].text,
    score: s.score,
  }));
}

function fallbackDiskSearch(queryEmbedding: Float32Array, limit: number): any[] {
  const rows = getDb().prepare(
    "SELECT id, file_path as filePath, chunk_index as chunkIndex, content, embedding FROM doc_chunks WHERE embedding IS NOT NULL"
  ).all() as any[];

  const expectedBytes = queryEmbedding.length * 4;
  const scored = rows
    .filter((row: any) => row.embedding && row.embedding.length === expectedBytes)
    .map((row: any) => {
      const emb = new Float32Array(new Uint8Array(row.embedding).buffer);
      const score = dotProduct(queryEmbedding, emb);
      return { filePath: row.filePath, chunkIndex: row.chunkIndex, text: row.content, score };
    });

  scored.sort((a: any, b: any) => b.score - a.score);
  return scored.slice(0, limit);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export function listDataManagers(moduleId?: string): any[] {
  const like = '%DataManager%';
  if (moduleId) {
    return getDb().prepare(
      `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
              line_number as lineNumber, namespace, phpdoc
       FROM classes
       WHERE (extends LIKE ? OR name LIKE ?) AND module_id = ? AND type = 'class'
       ORDER BY name LIMIT 100`
    ).all(like, like, moduleId);
  }
  return getDb().prepare(
    `SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, namespace, phpdoc
     FROM classes
     WHERE (extends LIKE ? OR name LIKE ?) AND type = 'class'
     ORDER BY name LIMIT 500`
  ).all(like, like);
}

export function getEntityFields(className: string, moduleId: string): any[] {
  const row = getDb().prepare(
    "SELECT file_path as filePath FROM classes WHERE name = ? AND module_id = ? AND type = 'class' LIMIT 1"
  ).get(className, moduleId) as any;
  if (!row || !existsSync(row.filePath)) return [];

  const content = readFileSync(row.filePath, "utf-8");
  const fields: any[] = [];

  const getMapBody = extractGetMapBody(content);
  if (!getMapBody) return fields;

  const fieldRe = /new\s+(?:\\?(?:Bitrix\\Main\\ORM\\Fields|Entity)\\)?(\w+Field)\s*\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(getMapBody)) !== null) {
    const type = match[1];
    const name = match[2];

    const argStart = match.index + match[0].length;
    let argEnd = argStart;
    let depth = 0;
    for (let i = argStart; i < getMapBody.length; i++) {
      const ch = getMapBody[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) { argEnd = i + 1; break; }
        depth--;
      }
      argEnd = i + 1;
    }

    const argsStr = getMapBody.substring(argStart, argEnd).trim();
    let options: any = {};
    if (argsStr.startsWith('[')) {
      try {
        const optMatch = argsStr.match(/\[([\s\S]*?)\]/);
        if (optMatch) {
          const optStr = optMatch[1];
          const optRe = /'(\w+)'\s*=>\s*([^,\]]+)/g;
          let om: RegExpExecArray | null;
          while ((om = optRe.exec(optStr)) !== null) {
            const val = om[2].trim();
            options[om[1]] = val === 'true' ? true : val === 'false' ? false : val;
          }
        }
      } catch {}
    }

    fields.push({ name, type, options });
  }

  const chainRe = /\(new\s+(?:\\?(?:Bitrix\\Main\\ORM\\Fields|Entity)\\)?(\w+Field)\s*\(\s*'([^']+)'[\s\S]*?\)\s*\)/g;
  chainRe.lastIndex = 0;
  while ((match = chainRe.exec(getMapBody)) !== null) {
    const type = match[1];
    const name = match[2];
    if (!fields.some(f => f.name === name && f.type === type)) {
      fields.push({ name, type, options: {} });
    }
  }

  return fields;
}

function extractGetMapBody(content: string): string | null {
  const methodRe = /function\s+getMap\s*\([\s\S]*?\)\s*\{/;
  const methodMatch = methodRe.exec(content);
  if (!methodMatch) return null;

  const bodyStart = methodMatch.index + methodMatch[0].length;
  let depth = 1;
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  return content.substring(bodyStart, bodyEnd);
}

export function getEventHandlers(eventName?: string): any[] {
  if (eventName) {
    return getDb().prepare(
      `SELECT name, module_id as moduleId, file_path as filePath,
              line_number as lineNumber, fired_in_function as firedInFunc
       FROM events WHERE name = ? ORDER BY module_id, file_path`
    ).all(eventName);
  }
  return getDb().prepare(
    `SELECT name, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, fired_in_function as firedInFunc
     FROM events ORDER BY name LIMIT 200`
  ).all();
}
