import Database from "better-sqlite3";
import { CONFIG } from "../utils/config.js";
let db;
export function initDb() {
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

    CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
    CREATE INDEX IF NOT EXISTS idx_functions_full_name ON functions(full_name);
    CREATE INDEX IF NOT EXISTS idx_functions_module ON functions(module_id);
    CREATE INDEX IF NOT EXISTS idx_functions_namespace ON functions(namespace);
    CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_classes_full_name ON classes(full_name);
    CREATE INDEX IF NOT EXISTS idx_classes_namespace ON classes(namespace);
    CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
    CREATE INDEX IF NOT EXISTS idx_events_module ON events(module_id);
  `);
}
export function getDb() {
    if (!db)
        initDb();
    return db;
}
export function upsertModule(id, name, path, version = "") {
    getDb().prepare("INSERT OR REPLACE INTO modules (id, name, version, path, indexed_at) VALUES (?, ?, ?, ?, datetime('now'))").run(id, name, version, path);
}
export function insertFunction(fn) {
    getDb().prepare(`INSERT INTO functions (name, full_name, module_id, file_path, line_number, phpdoc, code, args, is_method, class_name, visibility, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fn.name, fn.fullName, fn.moduleId, fn.filePath, fn.lineNumber, fn.phpdoc, fn.code, JSON.stringify(fn.args), fn.isMethod ? 1 : 0, fn.className || null, fn.visibility, fn.namespace || "");
}
export function insertClass(cls) {
    getDb().prepare(`INSERT INTO classes (name, full_name, module_id, file_path, line_number, type, extends, implements, phpdoc, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cls.name, cls.fullName, cls.moduleId, cls.filePath, cls.lineNumber, cls.type, JSON.stringify(cls.extends), JSON.stringify(cls.implements), cls.phpdoc, cls.namespace || "");
}
export function insertEvent(evt) {
    getDb().prepare(`INSERT INTO events (name, module_id, file_path, line_number, fired_in_function)
     VALUES (?, ?, ?, ?, ?)`).run(evt.name, evt.moduleId, evt.filePath, evt.lineNumber, evt.firedInFunction);
}
export function clearModuleData(moduleId) {
    getDb().prepare("DELETE FROM functions WHERE module_id = ?").run(moduleId);
    getDb().prepare("DELETE FROM classes WHERE module_id = ?").run(moduleId);
    getDb().prepare("DELETE FROM events WHERE module_id = ?").run(moduleId);
}
export function listModules() {
    return getDb().prepare("SELECT id, name, version FROM modules ORDER BY name").all();
}
export function getModuleFunctions(moduleId, limit, offset) {
    const total = getDb().prepare("SELECT COUNT(*) as cnt FROM functions WHERE module_id = ?").get(moduleId).cnt;
    const functions = getDb().prepare(`SELECT id, name, full_name as fullName, line_number as lineNumber, file_path as filePath, args,
            is_method as isMethod, class_name as className, visibility, namespace
     FROM functions WHERE module_id = ? ORDER BY name LIMIT ? OFFSET ?`).all(moduleId, limit, offset);
    return { functions, total };
}
export function getModuleEvents(moduleId) {
    return getDb().prepare("SELECT name, file_path as filePath, line_number as lineNumber, fired_in_function as firedInFunc FROM events WHERE module_id = ? ORDER BY name").all(moduleId);
}
export function findFunction(name, moduleId) {
    if (moduleId) {
        return getDb().prepare(`SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
              line_number as lineNumber, is_method as isMethod, class_name as className, namespace
       FROM functions WHERE (name LIKE ? OR full_name LIKE ?) AND module_id = ? ORDER BY name LIMIT 50`).all(`%${name}%`, `%${name}%`, moduleId);
    }
    return getDb().prepare(`SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, is_method as isMethod, class_name as className, namespace
     FROM functions WHERE name LIKE ? OR full_name LIKE ? ORDER BY name LIMIT 50`).all(`%${name}%`, `%${name}%`);
}
export function findFunctionExact(name) {
    return getDb().prepare(`SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, is_method as isMethod, class_name as className, namespace
     FROM functions WHERE name = ? OR full_name = ? ORDER BY name LIMIT 50`).all(name, name);
}
export function findByNamespace(namespace) {
    const ns = namespace.endsWith("\\") ? namespace : namespace + "\\";
    const classes = getDb().prepare(`SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath, line_number as lineNumber, type
     FROM classes WHERE namespace = ? OR full_name = ? ORDER BY name LIMIT 50`).all(namespace, namespace);
    const functions = getDb().prepare(`SELECT name, full_name as fullName, module_id as moduleId, file_path as filePath, line_number as lineNumber,
            is_method as isMethod, class_name as className, visibility, namespace
     FROM functions WHERE namespace = ? OR full_name LIKE ? ORDER BY name LIMIT 100`).all(namespace, ns + "%");
    return { classes, functions };
}
export function getClasses(moduleId, limit, offset) {
    const total = getDb().prepare("SELECT COUNT(*) as cnt FROM classes WHERE module_id = ?").get(moduleId).cnt;
    const classes = getDb().prepare(`SELECT id, name, full_name as fullName, module_id as moduleId, file_path as filePath,
            line_number as lineNumber, type, extends, implements, namespace
     FROM classes WHERE module_id = ? ORDER BY name LIMIT ? OFFSET ?`).all(moduleId, limit, offset);
    return { classes, total };
}
export function getFunctionCode(name, moduleId) {
    const row = getDb().prepare("SELECT phpdoc, code, file_path as filePath, line_number as lineNumber FROM functions WHERE name = ? AND module_id = ? LIMIT 1").get(name, moduleId);
    if (!row)
        return null;
    return `${row.phpdoc || ""}\n// File: ${row.filePath}:${row.lineNumber}\n${row.code || ""}`;
}
export function insertDocChunk(filePath, chunkIndex, content, embedding) {
    getDb().prepare("INSERT INTO doc_chunks (file_path, chunk_index, content, embedding) VALUES (?, ?, ?, ?)").run(filePath, chunkIndex, content, embedding);
}
export function clearDocChunks() {
    getDb().prepare("DELETE FROM doc_chunks").run();
}
export function searchDocChunks(queryEmbedding, limit = 10) {
    const rows = getDb().prepare("SELECT id, file_path as filePath, chunk_index as chunkIndex, content, embedding FROM doc_chunks WHERE embedding IS NOT NULL").all();
    const scored = rows.map((row) => {
        const emb = new Float32Array(new Uint8Array(row.embedding).buffer);
        const score = cosineSimilarity(queryEmbedding, emb);
        return { filePath: row.filePath, chunkIndex: row.chunkIndex, text: row.content, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
//# sourceMappingURL=storage.js.map