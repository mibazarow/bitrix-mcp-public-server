import { readFileSync, existsSync } from "fs";

export interface ParsedFunction {
  name: string;
  lineNumber: number;
  phpdoc: string;
  code: string;
  args: { type: string; name: string; defaultValue?: string }[];
  isMethod: boolean;
  className?: string;
  visibility: string;
}

export interface ParsedClass {
  name: string;
  lineNumber: number;
  type: "class" | "interface" | "trait";
  extends: string[];
  implements: string[];
  phpdoc: string;
}

export interface ParsedEvent {
  name: string;
  lineNumber: number;
  firedInFunction: string;
}

export interface ParsedConstant {
  name: string;
  lineNumber: number;
  value: string;
}

const PHP_FUNCTION_RE = /(?:\/\*\*[\s\S]*?\*\/)?\s*(?:public\s+|protected\s+|private\s+|static\s+)*(?:function\s+)([a-zA-Z_\\][a-zA-Z0-9_]*)\s*\(([^)]*)\)/gm;
const PHP_CLASS_RE = /(?:\/\*\*[\s\S]*?\*\/)?\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([a-zA-Z_\\][a-zA-Z0-9_]*)\s*(?:extends\s+([a-zA-Z_\\][a-zA-Z0-9_\\]*))?\s*(?:implements\s+([a-zA-Z_\\][a-zA-Z0-9_\\,\s]*))?/gm;
const PHP_NAMESPACE_RE = /namespace\s+([a-zA-Z_\\][a-zA-Z0-9_\\]*)\s*;/g;
const PHP_DEFINE_RE = /define\s*\(\s*["\x27]([a-zA-Z_][a-zA-Z0-9_]*)["\x27]\s*,/g;
const EVENT_GET_MODULE_EVENTS = /GetModuleEvents\s*\(\s*["\x27]([a-zA-Z0-9_]+)["\x27]\s*,\s*["\x27]([a-zA-Z0-9_]+)["\x27]/g;
const EVENT_REGISTER = /registerEventHandler\s*\(\s*["\x27]([a-zA-Z0-9_]+)["\x27]\s*,\s*["\x27]([a-zA-Z0-9_]+)["\x27]/g;

function extractPhpdoc(content: string, funcIndex: number): string {
  const before = content.substring(0, funcIndex).trimEnd();
  const lines = before.split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine.endsWith("/**") || lastLine.startsWith("/**")) {
    let docLines: string[] = [];
    let i = lines.length - 1;
    while (i >= 0) {
      const l = lines[i].trim();
      docLines.unshift(l);
      if (l.endsWith("*/")) break;
      i--;
    }
    return docLines.join("\n");
  }
  return "";
}

function extractPhpdocBefore(content: string, index: number): string {
  const slice = content.substring(0, index).trimEnd();
  if (slice.endsWith("/**") || slice.endsWith("*/")) {
    const lastBrace = slice.lastIndexOf("*/");
    if (lastBrace >= 0) {
      const start = slice.lastIndexOf("/**", lastBrace);
      if (start >= 0) return slice.substring(start, lastBrace + 2);
    }
  }
  return "";
}

export function parsePhpFunctions(phpCode: string, filePath: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];
  let match: RegExpExecArray | null;

  const lines = phpCode.split("\n");
  PHP_FUNCTION_RE.lastIndex = 0;

  while ((match = PHP_FUNCTION_RE.exec(phpCode)) !== null) {
    const name = match[1];
    const argsStr = match[2];
    const funcIndex = match.index;
    const phpdoc = extractPhpdocBefore(phpCode, funcIndex);

    const lineNum = phpCode.substring(0, funcIndex).split("\n").length;

    const args = argsStr.split(",").filter((a) => a.trim().length > 0).map((a) => {
      const parts = a.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { type: parts[0], name: parts[parts.length - 1].replace(/^[\$&]/, "") };
      }
      return { type: "mixed", name: a.trim().replace(/^[\$&]/, "") };
    });

    functions.push({
      name,
      lineNumber: lineNum,
      phpdoc,
      code: extractFunctionCode(lines, lineNum),
      args,
      isMethod: false,
      visibility: "public",
    });
  }

  return functions;
}

function extractFunctionCode(lines: string[], startLine: number): string {
  let code = "";
  let braceCount = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    if (!started) {
      if (line.includes("function")) started = true;
    }
    if (started) {
      code += line + "\n";
      for (const ch of line) {
        if (ch === "{") braceCount++;
        if (ch === "}") braceCount--;
      }
      if (started && braceCount === 0 && code.trim().endsWith("}")) break;
    }
  }
  return code;
}

export function parsePhpClasses(phpCode: string, filePath: string): ParsedClass[] {
  const classes: ParsedClass[] = [];
  let match: RegExpExecArray | null;

  PHP_CLASS_RE.lastIndex = 0;

  while ((match = PHP_CLASS_RE.exec(phpCode)) !== null) {
    const name = match[1];
    const extendsClass = match[2] || "";
    const implementsStr = match[3] || "";
    const phpdoc = extractPhpdocBefore(phpCode, match.index);
    const lineNum = phpCode.substring(0, match.index).split("\n").length;

    const type: "class" | "interface" | "trait" = (() => {
      const ctx = phpCode.substring(match.index, match.index + 100);
      if (ctx.startsWith("interface")) return "interface";
      if (ctx.startsWith("trait")) return "trait";
      return "class";
    })();

    classes.push({
      name,
      lineNumber: lineNum,
      type,
      extends: extendsClass ? extendsClass.split(",").map((s) => s.trim()) : [],
      implements: implementsStr ? implementsStr.split(",").map((s) => s.trim()) : [],
      phpdoc,
    });
  }

  return classes;
}

export function parsePhpConstants(phpCode: string): ParsedConstant[] {
  const constants: ParsedConstant[] = [];
  let match: RegExpExecArray | null;

  PHP_DEFINE_RE.lastIndex = 0;
  while ((match = PHP_DEFINE_RE.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    constants.push({ name: match[1], lineNumber: lineNum, value: "" });
  }

  return constants;
}

export function parsePhpEvents(phpCode: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let match: RegExpExecArray | null;

  EVENT_GET_MODULE_EVENTS.lastIndex = 0;
  while ((match = EVENT_GET_MODULE_EVENTS.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    events.push({ name: match[2], lineNumber: lineNum, firedInFunction: match[1] });
  }

  EVENT_REGISTER.lastIndex = 0;
  while ((match = EVENT_REGISTER.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    events.push({ name: match[2], lineNumber: lineNum, firedInFunction: match[1] });
  }

  return events;
}
