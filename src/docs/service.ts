import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from "fs";
import { join, relative, extname } from "path";
import { CONFIG } from "../utils/config.js";

export function ensureDocsDir(): void {
  if (!existsSync(CONFIG.docsPath)) {
    mkdirSync(CONFIG.docsPath, { recursive: true });
  }
}

export function getDocTree(dir: string = CONFIG.docsPath): any[] {
  const entries: any[] = [];
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const fullPath = join(dir, item.name);
      const relPath = relative(CONFIG.docsPath, fullPath);
      if (item.isDirectory()) {
        entries.push({ type: "dir", path: relPath, name: item.name, children: getDocTree(fullPath) });
      } else if (item.name.endsWith(".md")) {
        entries.push({ type: "file", path: relPath, name: item.name });
      }
    }
  } catch {}
  return entries;
}

export function getDocContent(relPath: string): string | null {
  const fullPath = join(CONFIG.docsPath, relPath);
  if (!existsSync(fullPath) || !fullPath.endsWith(".md")) return null;
  return readFileSync(fullPath, "utf-8");
}

export function getDocChunks(): { filePath: string; content: string }[] {
  const chunks: { filePath: string; content: string }[] = [];
  collectMdFiles(CONFIG.docsPath, CONFIG.docsPath, chunks);
  return chunks.map((c) => ({
    filePath: c.filePath,
    content: c.content,
  }));
}

export function listMdFiles(dir: string = CONFIG.docsPath): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    try {
      const items = readdirSync(d, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = join(d, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
        } else if (item.name.endsWith('.md')) {
          files.push(relative(CONFIG.docsPath, fullPath));
        }
      }
    } catch {}
  };
  walk(dir);
  return files;
}

function collectMdFiles(dir: string, baseDir: string, result: { filePath: string; content: string }[]): void {
function listMdFiles(dir: string = CONFIG.docsPath): string[] {  const files: string[] = [];  const walk = (d: string) => {    try {      const items = readdirSync(d, { withFileTypes: true });      for (const item of items) {        if (item.name.startsWith(".")) continue;        const fullPath = join(d, item.name);        if (item.isDirectory()) {          walk(fullPath);        } else if (item.name.endsWith(".md")) {          files.push(require("path").relative(CONFIG.docsPath, fullPath));        }      }    } catch {}  };  walk(dir);  return files;}
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        collectMdFiles(fullPath, baseDir, result);
      } else if (item.name.endsWith(".md")) {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(baseDir, fullPath);
        const chunks = splitIntoChunks(content);
        for (const chunk of chunks) {
          result.push({ filePath: relPath, content: chunk });
        }
      }
    }
  } catch {}
}

function splitIntoChunks(content: string): string[] {
  const chunks: string[] = [];
  const sections = content.split(/(?=^#{1,3}\s)/m);
  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length < 50) continue;
    if (trimmed.length > 1500) {
      const subChunks = trimmed.match(/(.|[\r\n]){1,1500}/g) || [trimmed];
      chunks.push(...subChunks);
    } else {
      chunks.push(trimmed);
    }
  }
  if (chunks.length === 0 && content.trim().length >= 50) {
    chunks.push(content.trim());
  }
  return chunks;
}
