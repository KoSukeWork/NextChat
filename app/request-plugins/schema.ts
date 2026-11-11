import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const condition = z
  .object({
    field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
    value: z.string(),
  })
  .strict();
const field = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    type: z.enum(["string", "secret", "select"]),
    default: z.string().max(10000).optional(),
    when: condition.optional(),
    options: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .max(40)
      .optional(),
  })
  .strict();

/** Portable package format. Executable ESM is installed as data, never bundled. */
export const pluginPackageSchema = z
  .object({
    manifest: z
      .object({
        sdkVersion: z.union([z.literal(1), z.literal(2)]),
        id: identifier,
        version,
        name: z.string().min(1).max(120),
        description: z.string().max(2000),
        protocols: z
          .array(
            z.enum(["anthropic", "openai-chat", "openai-responses", "gemini"]),
          )
          .min(1),
        capabilities: z
          .array(z.enum(["request", "driver", "transport"]))
          .min(1),
        fields: z
          .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/), field)
          .default({}),
        localServices: z
          .array(
            z
              .object({
                id: identifier,
                title: z.string().min(1).max(120),
                when: condition.optional(),
                urlField: z.string(),
                tokenField: z.string(),
                versionField: z.string().optional(),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict(),
    source: z.string().min(1).max(512000),
  })
  .strict();

export type RequestPluginPackage = z.infer<typeof pluginPackageSchema>;
export type InstalledRequestPlugin = RequestPluginPackage & {
  enabled: boolean;
};
export type RequestPluginBinding = {
  id: string;
  version: string;
  config: Record<string, string>;
};

export function parsePluginPackage(value: unknown): RequestPluginPackage {
  const result = pluginPackageSchema.parse(value);
  if (
    result.manifest.capabilities.includes("transport") &&
    result.manifest.sdkVersion !== 2
  )
    throw new Error("Transport extensions require plugin SDK 2");
  for (const [key, value] of Object.entries(result.manifest.fields)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("Reserved configuration key");
    if (value.type === "select" && !value.options?.length)
      throw new Error(`Missing choices for ${key}`);
    if (value.when) {
      const selector = result.manifest.fields[value.when.field];
      if (
        key === value.when.field ||
        selector?.type !== "select" ||
        selector.when ||
        !selector.options?.some((option) => option.value === value.when!.value)
      )
        throw new Error(
          `Invalid configuration visibility condition for ${key}`,
        );
    }
  }
  const serviceIds = new Set<string>();
  for (const service of result.manifest.localServices ?? []) {
    const fields = result.manifest.fields;
    if (
      result.manifest.sdkVersion !== 2 ||
      serviceIds.has(service.id) ||
      fields[service.urlField]?.type !== "string" ||
      fields[service.tokenField]?.type !== "secret" ||
      (service.versionField &&
        fields[service.versionField]?.type !== "string") ||
      (service.when &&
        (fields[service.when.field]?.type !== "select" ||
          fields[service.when.field].when ||
          !fields[service.when.field].options?.some(
            (option) => option.value === service.when!.value,
          )))
    )
      throw new Error("Invalid local service declaration");
    serviceIds.add(service.id);
  }
  return result;
}

export function pluginDefaults(pkg: RequestPluginPackage) {
  return Object.fromEntries(
    Object.entries(pkg.manifest.fields).map(([key, field]) => [
      key,
      field.default ?? "",
    ]),
  );
}

export function installPlugin(
  installed: InstalledRequestPlugin[],
  value: unknown,
) {
  const pkg = parsePluginPackage(value);
  const previous = installed.find(
    (p) =>
      p.manifest.id === pkg.manifest.id &&
      p.manifest.version === pkg.manifest.version,
  );
  if (previous) {
    if (
      JSON.stringify({
        manifest: previous.manifest,
        source: previous.source,
      }) !== JSON.stringify(pkg)
    )
      throw new Error(
        "This version already exists with different contents. Publish a new version.",
      );
    return installed.map((p) => (p === previous ? { ...p, enabled: true } : p));
  }
  return [...installed, { ...pkg, enabled: true }];
}
