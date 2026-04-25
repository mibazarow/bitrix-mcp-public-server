export interface ParsedFunction {
  name: string;
  fullName: string;
  lineNumber: number;
  phpdoc: string;
  code: string;
  args: { type: string; name: string; defaultValue?: string }[];
  isMethod: boolean;
  className?: string;
  visibility: string;
  namespace: string;
}

export interface ParsedClass {
  name: string;
  fullName: string;
  lineNumber: number;
  type: "class" | "interface" | "trait";
  extends: string[];
  implements: string[];
  phpdoc: string;
  namespace: string;
}

export interface ParsedEvent {
  name: string;
  lineNumber: number;
  firedInFunction: string;
}

const PHP_NAMESPACE_RE = /namespace\s+([a-zA-Z_\\][a-zA-Z0-9_\\]*)\s*;/g;
const PHP_CLASS_RE = /(?:\/\*\*[\s\S]*?\*\/)?\s*(?:abstract\s+|final\s+)?(class|interface|trait)\s+([a-zA-Z_\\][a-zA-Z0-9_]*)\s*(?:extends\s+([a-zA-Z_\\][a-zA-Z0-9_\\]*))?\s*(?:implements\s+([a-zA-Z_\\][a-zA-Z0-9_\\,\s]*))?/gm;

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

function extractNamespace(content: string): string {
  PHP_NAMESPACE_RE.lastIndex = 0;
  const m = PHP_NAMESPACE_RE.exec(content);
  return m ? m[1] : "";
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

interface ClassBlock {
  name: string;
  startLine: number;
  endLine: number;
}

function parseClassBlocks(content: string, lines: string[]): ClassBlock[] {
  const blocks: ClassBlock[] = [];
  const re = /(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([a-zA-Z_\\][a-zA-Z0-9_]*)/gm;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const classIndex = match.index;
    const startLine = content.substring(0, classIndex).split("\n").length;
    const name = match[1];
    let braceCount = 0;
    let endLine = startLine;
    let started = false;
    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      if (!started) {
        if (line.includes("{")) started = true;
      }
      if (started) {
        for (const ch of line) {
          if (ch === "{") braceCount++;
          if (ch === "}") braceCount--;
        }
        if (braceCount === 0) { endLine = i + 1; break; }
      }
    }
    blocks.push({ name, startLine, endLine });
  }
  return blocks;
}

function isInsideClass(lineNumber: number, classBlocks: ClassBlock[]): ClassBlock | null {
  for (const block of classBlocks) {
    if (lineNumber >= block.startLine && lineNumber <= block.endLine) {
      if (lineNumber > block.startLine) return block;
    }
  }
  return null;
}

const METHOD_RE = /(?:\/\*\*[\s\S]*?\*\/)?\s*((?:public|protected|private|static|abstract|final)\s+(?:public|protected|private|static|abstract|final|\s)*)?function\s+([a-zA-Z_\\][a-zA-Z0-9_]*)\s*\(([^)]*)\)/gm;

export function parsePhpFunctions(phpCode: string, filePath: string, namespace: string, classBlocks: ClassBlock[]): ParsedFunction[] {
  const functions: ParsedFunction[] = [];
  let match: RegExpExecArray | null;
  const lines = phpCode.split("\n");
  METHOD_RE.lastIndex = 0;

  while ((match = METHOD_RE.exec(phpCode)) !== null) {
    const name = match[2];
    const argsStr = match[3];
    const funcIndex = match.index;
    const phpdoc = extractPhpdocBefore(phpCode, funcIndex);

    const lineNum = phpCode.substring(0, funcIndex).split("\n").length;

    const visibilityStr = match[1] || "";
    const enclosingClass = isInsideClass(lineNum, classBlocks);

    let visibility = "public";
    let isMethod = false;
    let className: string | undefined;

    if (enclosingClass) {
      isMethod = true;
      className = enclosingClass.name;
      if (visibilityStr.includes("private")) visibility = "private";
      else if (visibilityStr.includes("protected")) visibility = "protected";
      else if (visibilityStr.includes("public")) visibility = "public";
    }

    const ns = namespace || "";
    const prefix = ns ? ns + "\\" : "";
    const classPrefix = className ? (prefix + className + "::") : "";
    const fullName = classPrefix + name;

    const args = argsStr.split(",").filter((a) => a.trim().length > 0).map((a) => {
      const parts = a.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { type: parts[0], name: parts[parts.length - 1].replace(/^[\$&]/, "") };
      }
      return { type: "mixed", name: a.trim().replace(/^[\$&]/, "") };
    });

    functions.push({
      name,
      fullName,
      lineNumber: lineNum,
      phpdoc,
      code: extractFunctionCode(lines, lineNum),
      args,
      isMethod,
      className,
      visibility,
      namespace: ns,
    });
  }

  return functions;
}

export function parsePhpClasses(phpCode: string, filePath: string, namespace: string): ParsedClass[] {
  const classes: ParsedClass[] = [];
  let match: RegExpExecArray | null;

  PHP_CLASS_RE.lastIndex = 0;
  const ns = namespace || "";

  while ((match = PHP_CLASS_RE.exec(phpCode)) !== null) {
    const classKeyword = match[1];
    const name = match[2];
    const extendsClass = match[3] || "";
    const implementsStr = match[4] || "";
    const phpdoc = extractPhpdocBefore(phpCode, match.index);
    const lineNum = phpCode.substring(0, match.index).split("\n").length;

    const type = classKeyword === "interface" ? "interface" : classKeyword === "trait" ? "trait" : "class";
    const fullName = ns ? ns + "\\" + name : name;

    classes.push({
      name,
      fullName,
      lineNumber: lineNum,
      type,
      extends: extendsClass ? extendsClass.split(",").map((s) => s.trim()) : [],
      implements: implementsStr ? implementsStr.split(",").map((s) => s.trim()) : [],
      phpdoc,
      namespace: ns,
    });
  }

  return classes;
}

export function parsePhpConstants(phpCode: string): { name: string; lineNumber: number; value: string }[] {
  const constants: { name: string; lineNumber: number; value: string }[] = [];
  let match: RegExpExecArray | null;
  const re = /define\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']\s*,/g;
  while ((match = re.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    constants.push({ name: match[1], lineNumber: lineNum, value: "" });
  }
  return constants;
}

export function parsePhpEvents(phpCode: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let match: RegExpExecArray | null;

  const re1 = /GetModuleEvents\s*\(\s*["']([a-zA-Z0-9_]+)["']\s*,\s*["']([a-zA-Z0-9_]+)["']/g;
  while ((match = re1.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    events.push({ name: match[2], lineNumber: lineNum, firedInFunction: match[1] });
  }

  const re2 = /registerEventHandler\s*\(\s*["']([a-zA-Z0-9_]+)["']\s*,\s*["']([a-zA-Z0-9_]+)["']/g;
  while ((match = re2.exec(phpCode)) !== null) {
    const lineNum = phpCode.substring(0, match.index).split("\n").length;
    events.push({ name: match[2], lineNumber: lineNum, firedInFunction: match[1] });
  }

  return events;
}

export function parseNamespace(content: string): string {
  return extractNamespace(content);
}

export function parseClassBlocksFromContent(content: string): ClassBlock[] {
  const lines = content.split("\n");
  return parseClassBlocks(content, lines);
}
