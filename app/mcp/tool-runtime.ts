import type { EndpointTool } from "../client/endpoint-protocol";

export interface ToolDisplay {
  source: "mcp" | "plugin";
  server: string;
  name: string;
}

export interface ToolResult {
  __toolResult: true;
  content: string;
  isError: boolean;
}

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};
export type McpToolGroup = {
  clientId: string;
  tools: { tools: ToolDefinition[] } | null;
};
export type PluginToolGroup = {
  id: string;
  name: string;
  tools: EndpointTool[];
  funcs: Record<string, Function>;
};

/** Keep wire names within the common provider alphabet and length limit. */
export function safeToolName(
  source: string,
  owner: string,
  name: string,
  used: Set<string>,
) {
  const raw = `${source}_${owner}_${name}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++)
    hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
  const prefix = raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "tool";
  const base = `${prefix}_${(hash >>> 0).toString(36)}`;
  let result = base.slice(0, 64);
  for (let i = 2; used.has(result); i++) {
    const suffix = `_${i}`;
    result = base.slice(0, 64 - suffix.length) + suffix;
  }
  used.add(result);
  return result;
}

/** Gemini accepts a subset of JSON Schema. Resolve local refs before filtering. */
export function geminiSchema(schema: unknown): unknown {
  const root =
    schema && typeof schema === "object" ? (schema as Record<string, any>) : {};
  const allowed = new Set([
    "type",
    "description",
    "format",
    "nullable",
    "enum",
    "items",
    "properties",
    "required",
    "anyOf",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
    "title",
    "propertyOrdering",
  ]);
  const visit = (value: any, refs: Set<string>, propertyMap = false): any => {
    if (Array.isArray(value)) return value.map((part) => visit(part, refs));
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      const ref = value.$ref;
      if (refs.has(ref)) return { type: "object" };
      const target = ref
        .slice(2)
        .split("/")
        .reduce(
          (obj: any, key: string) =>
            obj?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          root,
        );
      if (target)
        return visit(
          {
            ...target,
            ...Object.fromEntries(
              Object.entries(value).filter(([key]) => key !== "$ref"),
            ),
          },
          new Set([...refs, ref]),
        );
    }
    const out: Record<string, any> = {};
    for (const [key, part] of Object.entries(value)) {
      if (!propertyMap && key === "type" && Array.isArray(part)) {
        const types = part.filter((type) => type !== "null");
        if (types.length === 1) {
          out.type = types[0];
          if (types.length !== part.length) out.nullable = true;
        } else if (!types.length) {
          out.type = "null";
        } else {
          out.anyOf = types.map((type) => ({ type }));
          if (types.length !== part.length) out.nullable = true;
        }
        continue;
      }
      if (propertyMap || allowed.has(key))
        out[key] = visit(part, refs, key === "properties");
    }
    return out;
  };
  const result = visit(root, new Set());
  return Object.keys(result).length
    ? result
    : { type: "object", properties: {} };
}

/** Preserve non-text metadata but never put binary payloads into model context. */
export function formatMcpResult(result: any): ToolResult {
  const redact = (value: any): any => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    const binary =
      value.type === "image" ||
      value.type === "audio" ||
      value.encoding === "base64";
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [
        key,
        (key === "blob" || (binary && key === "data")) &&
        typeof part === "string"
          ? `[binary omitted; ${part.length} encoded characters]`
          : redact(part),
      ]),
    );
  };
  const contents = Array.isArray(result?.content) ? result.content : null;
  const content = contents
    ? contents
        .map((part: any) =>
          part?.type === "text" && typeof part.text === "string"
            ? part.text
            : JSON.stringify(redact(part)),
        )
        .join("\n")
    : typeof result === "string"
    ? result
    : JSON.stringify(redact(result ?? ""));
  const other =
    result && typeof result === "object"
      ? Object.fromEntries(
          Object.entries(result).filter(
            ([key]) => key !== "content" && key !== "isError",
          ),
        )
      : {};
  return {
    __toolResult: true,
    content:
      content +
      (Object.keys(other).length ? `\n${JSON.stringify(redact(other))}` : ""),
    isError: result?.isError === true,
  };
}

export function createToolRegistry(
  mcp: McpToolGroup[],
  plugins: PluginToolGroup[],
  execute: (clientId: string, name: string, args: unknown) => Promise<unknown>,
) {
  const used = new Set<string>();
  const tools: EndpointTool[] = [];
  const funcs: Record<string, Function> = {};
  const display: Record<string, ToolDisplay> = {};
  for (const group of mcp)
    for (const tool of group.tools?.tools ?? []) {
      const wire = safeToolName("mcp", group.clientId, tool.name, used);
      tools.push({
        type: "function",
        function: {
          name: wire,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      });
      display[wire] = {
        source: "mcp",
        server: group.clientId,
        name: tool.name,
      };
      funcs[wire] = async (args: unknown) =>
        formatMcpResult(await execute(group.clientId, tool.name, args));
    }
  for (const group of plugins)
    for (const tool of group.tools) {
      const original = tool.function.name;
      const run = group.funcs[original];
      if (!run) continue;
      const wire = safeToolName("plugin", group.id, original, used);
      tools.push({ ...tool, function: { ...tool.function, name: wire } });
      display[wire] = { source: "plugin", server: group.name, name: original };
      funcs[wire] = (args: unknown) => run(args);
    }
  return { tools, funcs, display };
}
