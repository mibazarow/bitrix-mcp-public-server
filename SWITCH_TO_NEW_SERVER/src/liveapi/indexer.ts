import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG } from "../utils/config.js";
import {
  parsePhpFunctions, parsePhpClasses, parsePhpEvents, parsePhpConstants,
  parsePhpConstantsFull, parseFunctionUsages,
  parseNamespace, parseClassBlocksFromContent
} from "../utils/php-parser.js";
import { upsertModule, clearModuleData, insertFunction, insertClass, insertEvent, insertClassConstant, insertFunctionUsage } from "./storage.js";

export interface IndexProgress {
  total: number;
  current: number;
  module: string;
  file: string;
}

export function indexAllModules(onProgress?: (p: IndexProgress) => void): { modulesIndexed: number; functionsIndexed: number } {
  const modulesPath = CONFIG.bitrixPath;
  if (!existsSync(modulesPath)) {
    throw new Error(`Bitrix modules path not found: ${modulesPath}`);
  }

  const moduleDirs = readdirSync(modulesPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let totalFunctions = 0;

  for (let i = 0; i < moduleDirs.length; i++) {
    const modId = moduleDirs[i];
    const modPath = join(modulesPath, modId);

    const version = readModuleVersion(modPath);
    upsertModule(modId, modId, modPath, version);
    clearModuleData(modId);

    const phpFiles = collectPhpFiles(modPath);
    let fileCount = 0;

    onProgress?.({
      total: moduleDirs.length,
      current: i + 1,
      module: modId,
      file: `0/${phpFiles.length}`,
    });

    for (const filePath of phpFiles) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const namespace = parseNamespace(content);
        const classBlocks = parseClassBlocksFromContent(content);

        const functions = parsePhpFunctions(content, filePath, namespace, classBlocks);
        for (const fn of functions) {
          insertFunction({ ...fn, moduleId: modId, filePath });
        }

        const classes = parsePhpClasses(content, filePath, namespace);
        for (const cls of classes) {
          insertClass({ ...cls, moduleId: modId, filePath });
        }

        const events = parsePhpEvents(content);
        for (const evt of events) {
          insertEvent({ ...evt, moduleId: modId, filePath });
        }

        const constants = parsePhpConstantsFull(content, namespace, classBlocks);
        for (const c of constants) {
          insertClassConstant({ ...c, moduleId: modId, filePath });
        }

        const usages = parseFunctionUsages(content, filePath, modId);
        for (const u of usages) {
          insertFunctionUsage({ ...u, moduleId: modId });
        }

        totalFunctions += functions.length;
        fileCount++;

        onProgress?.({
          total: moduleDirs.length,
          current: i + 1,
          module: modId,
          file: `${fileCount}/${phpFiles.length}`,
        });
      } catch (err) {
        // skip parse errors for individual files
      }
    }
  }

  return { modulesIndexed: moduleDirs.length, functionsIndexed: totalFunctions };
}

function readModuleVersion(modPath: string): string {
  try {
    const vf = join(modPath, "install", "version.php");
    if (existsSync(vf)) {
      const content = readFileSync(vf, "utf-8");
      const m = content.match(/'VERSION'\s*=>\s*'([^']+)'/);
      if (m) return m[1];
      const m2 = content.match(/"VERSION"\s*=>\s*"([^"]+)"/);
      if (m2) return m2[1];
    }
    const gv = join(modPath, "classes", "general", "version.php");
    if (existsSync(gv)) {
      const content = readFileSync(gv, "utf-8");
      const m = content.match(/define\s*\(\s*"SM_VERSION"\s*,\s*"([^"]+)"\s*\)/);
      if (m) return m[1];
    }
    return "";
  } catch { return ""; }
}

function collectPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // skip node_modules, .git, test directories
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "tests" || entry.name === "test") continue;
        files.push(...collectPhpFiles(fullPath));
      } else if (entry.name.endsWith(".php") && !entry.name.startsWith(".")) {
        files.push(fullPath);
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return files;
}

export function indexAllComponents(onProgress?: (p: IndexProgress) => void): { componentsIndexed: number; functionsIndexed: number } {
  const componentsPath = CONFIG.componentsPath;
  if (!existsSync(componentsPath)) {
    throw new Error(`Components path not found: ${componentsPath}`);
  }

  const namespaceDirs = readdirSync(componentsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let totalFunctions = 0;
  let totalComponents = 0;

  for (const ns of namespaceDirs) {
    const nsPath = join(componentsPath, ns);
    const componentDirs = readdirSync(nsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (let i = 0; i < componentDirs.length; i++) {
      const compName = componentDirs[i];
      const compPath = join(nsPath, compName);
      const modId = `comp:${ns}:${compName}`;

      upsertModule(modId, `${ns}:${compName}`, compPath, "");
      clearModuleData(modId);

      const phpFiles = collectPhpFiles(compPath);
      let fileCount = 0;

      for (const filePath of phpFiles) {
        try {
          const content = readFileSync(filePath, "utf-8");
          const namespace = parseNamespace(content);
          const classBlocks = parseClassBlocksFromContent(content);

          const functions = parsePhpFunctions(content, filePath, namespace, classBlocks);
          for (const fn of functions) {
            insertFunction({ ...fn, moduleId: modId, filePath });
          }

          const classes = parsePhpClasses(content, filePath, namespace);
          for (const cls of classes) {
            insertClass({ ...cls, moduleId: modId, filePath });
          }

          const events = parsePhpEvents(content);
          for (const evt of events) {
            insertEvent({ ...evt, moduleId: modId, filePath });
          }

          const constants = parsePhpConstantsFull(content, namespace, classBlocks);
          for (const c of constants) {
            insertClassConstant({ ...c, moduleId: modId, filePath });
          }

          const usages = parseFunctionUsages(content, filePath, modId);
          for (const u of usages) {
            insertFunctionUsage({ ...u, moduleId: modId });
          }

          totalFunctions += functions.length;
          fileCount++;
        } catch (err) {
          // skip parse errors for individual files
        }
      }

      onProgress?.({
        total: componentDirs.length,
        current: i + 1,
        module: modId,
        file: `${fileCount}/${phpFiles.length}`,
      });

      totalComponents++;
    }
  }

  return { componentsIndexed: totalComponents, functionsIndexed: totalFunctions };
}

export function hasChangesSince(date: Date): boolean {
  const modulesPath = CONFIG.bitrixPath;
  if (!existsSync(modulesPath)) return false;


  const moduleDirs = readdirSync(modulesPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const modId of moduleDirs) {
    const modPath = join(modulesPath, modId);
    const phpFiles = collectPhpFiles(modPath);
    for (const file of phpFiles) {
      if (statSync(file).mtime > date) return true;
    }
  }
  return false;
}
