/*
 * A small YAML reader for StageFlow choreography scores.
 *
 * StageFlow scores are a plain subset of YAML: block mappings and sequences,
 * flow arrays and objects, quoted and plain scalars, comments and the two block
 * scalars (`|` and `>`). Anchors, aliases, tags and multiple documents are not
 * used by any score in circulation and are rejected with a diagnostic here
 * instead of being read wrongly.
 *
 * The reader returns plain values. Field names, aliases and defaults are the
 * score normalizer's job (`parse.ts`), not this file's.
 */
import type {YamlDiagnostic, YamlValue} from "./schema";

type Line = {indent: number; text: string; number: number};

export type YamlResult = {value: YamlValue; diagnostics: YamlDiagnostic[]};

const isFlowStart = (c: string) => c === "[" || c === "{";

/** Strip a trailing comment. A `#` starts a comment at the start of a line or after whitespace, outside quotes. */
function stripComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/** Split `a: b` at the first colon that is outside quotes and flow collections. */
function splitKey(text: string): {key: string; rest: string} | null {
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (isFlowStart(c)) depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) {
      const next = text[i + 1];
      if (next !== undefined && next !== " " && next !== "\t") continue;
      return {key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim()};
    }
  }
  return null;
}

/** Split a flow collection body on commas that are not inside quotes or nested collections. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (isFlowStart(c)) depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim() || parts.length) parts.push(tail);
  return parts;
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const BOOLEans = new Set(["true", "yes", "on", "y"]);
const FALSE = new Set(["false", "no", "off", "n"]);
const NULLS = new Set(["null", "~", ""]);

function unquote(text: string): string | null {
  if (text.length < 2) return null;
  const first = text[0];
  if (first !== '"' && first !== "'") return null;
  if (text[text.length - 1] !== first) return null;
  if (first === "'") return text.slice(1, -1).replace(/''/g, "'");
  try {
    return JSON.parse(text) as string;
  } catch {
    return text.slice(1, -1);
  }
}

/** Read one scalar, a flow collection, or a quoted string. Returns null when the text is not a complete value. */
export function parseScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const quoted = unquote(trimmed);
  if (quoted !== null) return quoted;
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return trimmed;
    const body = trimmed.slice(1, -1);
    if (!body.trim()) return [];
    return splitFlow(body).map((part) => parseScalar(part));
  }
  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) return trimmed;
    const body = trimmed.slice(1, -1);
    if (!body.trim()) return {};
    const value: Record<string, YamlValue> = {};
    for (const part of splitFlow(body)) {
      const pair = splitKey(part.trim());
      if (!pair) return trimmed;
      value[unquote(pair.key) ?? pair.key] = parseScalar(pair.rest);
    }
    return value;
  }
  const lower = trimmed.toLowerCase();
  if (NULLS.has(lower)) return null;
  if (BOOLEans.has(lower)) return true;
  if (FALSE.has(lower)) return false;
  if (NUMBER.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Read a whole score. The parser is indentation based: two spaces per level is
 * the convention, but any consistent step works. A broken line becomes a
 * diagnostic instead of an exception, so the editor can point at it.
 */
export function parseYaml(source: string): YamlResult {
  const diagnostics: YamlDiagnostic[] = [];
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const withoutComment = stripComment(raw[i]);
    if (!withoutComment.trim()) continue;
    const expanded = withoutComment.replace(/\t/g, "  ");
    const indent = expanded.length - expanded.trimStart().length;
    lines.push({indent, text: expanded.trim().length ? expanded.trimEnd().slice(indent) : "", number: i + 1});
  }
  let cursor = 0;

  const fail = (line: number, message: string): never => {
    diagnostics.push({line, message, severity: "error"});
    throw new Error(message);
  };

  function readBlockScalar(parentIndent: number): string {
    const collected: string[] = [];
    while (cursor < lines.length && lines[cursor].indent > parentIndent) {
      collected.push(lines[cursor].text);
      cursor++;
    }
    return collected.join("\n");
  }

  function readValue(rest: string, line: number, indent: number, inlineMap: boolean): YamlValue {
    if (rest === "|" || rest === ">") {
      const body = readBlockScalar(indent);
      return inlineMap ? body : rest === ">" ? body.replace(/\n+/g, " ") : body;
    }
    if (rest === "") {
      if (cursor < lines.length && lines[cursor].indent > indent) return readNode();
      return null;
    }
    const scalar = parseScalar(rest);
    if (typeof scalar === "string" && isFlowStart(rest[0])) fail(line, `Unclosed flow collection: ${rest.slice(0, 40)}`);
    return scalar;
  }

  function readMap(indent: number, seed?: {key: string; rest: string; line: number}): Record<string, YamlValue> {
    const map: Record<string, YamlValue> = {};
    const readEntry = (key: string, rest: string, lineNumber: number) => {
      const name = unquote(key) ?? key;
      map[name] = readValue(rest, lineNumber, indent, true);
    };
    if (seed) readEntry(seed.key, seed.rest, seed.line);
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.number, `Unexpected indentation: ${line.text.slice(0, 60)}`);
      if (line.text.startsWith("- ") || line.text === "-") break;
      const pair = splitKey(line.text);
      if (!pair) {
        diagnostics.push({line: line.number, message: `Expected "key: value": ${line.text.slice(0, 60)}`, severity: "error"});
        throw new Error(`Expected "key: value" on line ${line.number}`);
      }
      cursor++;
      readEntry(pair.key, pair.rest, line.number);
    }
    return map;
  }

  function readSequence(indent: number): YamlValue[] {
    const list: YamlValue[] = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;
      const content = line.text === "-" ? "" : line.text.slice(2).trim();
      cursor++;
      if (!content) {
        list.push(cursor < lines.length && lines[cursor].indent > indent ? readNode() : null);
        continue;
      }
      const pair = splitKey(content);
      if (pair && !content.startsWith("{")) {
        list.push(readMap(indent + 2, {key: pair.key, rest: pair.rest, line: line.number}));
        continue;
      }
      list.push(parseScalar(content));
    }
    return list;
  }

  function readNode(): YamlValue {
    const line = lines[cursor];
    if (line.text.startsWith("- ") || line.text === "-") return readSequence(line.indent);
    return readMap(line.indent);
  }

  try {
    const value: YamlValue = lines.length ? readNode() : null;
    if (cursor < lines.length) fail(lines[cursor].number, `Unexpected content: ${lines[cursor].text.slice(0, 60)}`);
    return {value, diagnostics};
  } catch {
    return {value: null, diagnostics};
  }
}

/** Render a YAML scalar. Only used by tests and the export path for small values. */
export function scalarText(value: YamlValue): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(scalarText).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${key}: ${scalarText(item)}`).join(", ")}}`;
  if (/^[\w./:#-]+$/.test(value) && !/^(true|false|yes|no|on|off|null|~|[-+]?\d+\.?\d*)$/i.test(value)) return value;
  return JSON.stringify(value);
}
