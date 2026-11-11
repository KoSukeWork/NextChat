import { useRef, useState } from "react";
import Locale from "../locales";
import { useAppConfig } from "../store/config";
import {
  installPlugin,
  parsePluginPackage,
  pluginDefaults,
} from "../request-plugins/schema";
import type { Endpoint } from "../utils/endpoints";
import {
  List,
  ListItem,
  Select,
  PasswordInput,
  Modal,
  showConfirm,
  showToast,
} from "./ui-lib";
import { IconButton } from "./button";
import { createPluginSession } from "../request-plugins/host";
import { buildEndpointRequest } from "../client/endpoint-protocol";

const labels = () => Locale.RequestPlugins;

export function RequestPluginManager() {
  const config = useAppConfig();
  const upload = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const install = async (value: unknown) => {
    const pkg = parsePluginPackage(value);
    if (
      !(await showConfirm(
        `${pkg.manifest.name} ${pkg.manifest.version}\n\n${
          pkg.manifest.description
        }\n\n${labels().Trust}`,
      ))
    )
      return;
    config.update((state) => {
      state.requestPlugins = installPlugin(state.requestPlugins, pkg);
    });
  };
  const guarded = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      showToast(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <List>
      <ListItem title={labels().Title} subTitle={labels().Description}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={upload}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            aria-label={labels().Import}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file)
                void guarded(async () => {
                  if (file.size > 1024 * 1024)
                    throw new Error("Plugin package exceeds 1 MB");
                  await install(JSON.parse(await file.text()));
                });
            }}
          />
          <IconButton
            text={labels().Import}
            disabled={busy}
            onClick={() => upload.current?.click()}
          />
          <IconButton
            text={labels().InstallClaude}
            disabled={busy}
            onClick={() =>
              void guarded(async () => {
                const response = await fetch(
                  "./request-plugins/nextchat.claude-code-3.1.0-beta.1.json",
                );
                if (!response.ok)
                  throw new Error(`Package HTTP ${response.status}`);
                await install(await response.json());
              })
            }
          />
        </div>
      </ListItem>
      {config.requestPlugins.map((pkg) => {
        const { id, version, name } = pkg.manifest;
        const bound = config.endpoints.filter(
          (e) =>
            e.requestPlugin?.id === id && e.requestPlugin.version === version,
        ).length;
        return (
          <ListItem
            key={`${id}@${version}`}
            title={`${name} · ${version}`}
            subTitle={`${id} · ${labels().Bound}: ${bound}`}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                aria-label={`${labels().Enabled}: ${name} ${version}`}
                checked={pkg.enabled}
                onChange={async (event) => {
                  const enabled = event.currentTarget.checked;
                  if (
                    enabled &&
                    !(await showConfirm(
                      `${name} ${version}\n\n${labels().Trust}`,
                    ))
                  )
                    return;
                  config.update((state) => {
                    state.requestPlugins = state.requestPlugins.map((p) =>
                      p.manifest.id === id && p.manifest.version === version
                        ? { ...p, enabled }
                        : p,
                    );
                  });
                }}
              />
              <IconButton
                text={labels().Export}
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob(
                      [
                        JSON.stringify(
                          { manifest: pkg.manifest, source: pkg.source },
                          null,
                          2,
                        ),
                      ],
                      { type: "application/json" },
                    ),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${id}-${version}.json`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              />
              <IconButton
                text={labels().Remove}
                onClick={async () => {
                  if (!(await showConfirm(labels().RemoveConfirm))) return;
                  config.update((state) => {
                    state.requestPlugins = state.requestPlugins.filter(
                      (p) =>
                        p.manifest.id !== id || p.manifest.version !== version,
                    );
                  });
                }}
              />
            </div>
          </ListItem>
        );
      })}
    </List>
  );
}

export function EndpointRequestPlugin(props: {
  endpoint: Endpoint;
  onChange: (endpoint: Partial<Endpoint>) => void;
}) {
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const installed = useAppConfig((state) => state.requestPlugins);
  const binding = props.endpoint.requestPlugin;
  const key = binding ? `${binding.id}@${binding.version}` : "";
  const pkg = installed.find(
    (p) => `${p.manifest.id}@${p.manifest.version}` === key,
  );
  const compatible = installed.filter((p) =>
    p.manifest.protocols.includes(props.endpoint.protocol),
  );
  const config = pkg ? { ...pluginDefaults(pkg), ...binding?.config } : {};
  return (
    <>
      <ListItem title={labels().Select} subTitle={pkg?.manifest.description}>
        <Select
          aria-label={labels().Select}
          value={key}
          onChange={(event) => {
            const selected = installed.find(
              (p) =>
                `${p.manifest.id}@${p.manifest.version}` ===
                event.currentTarget.value,
            );
            props.onChange({
              requestPlugin: selected
                ? {
                    id: selected.manifest.id,
                    version: selected.manifest.version,
                    config: pluginDefaults(selected),
                  }
                : undefined,
            });
          }}
        >
          <option value="">{labels().Standard}</option>
          {key &&
            !compatible.some(
              (p) => `${p.manifest.id}@${p.manifest.version}` === key,
            ) && (
              <option value={key}>
                {key} · {labels().Unavailable}
              </option>
            )}
          {compatible.map((p) => (
            <option
              key={`${p.manifest.id}@${p.manifest.version}`}
              value={`${p.manifest.id}@${p.manifest.version}`}
              disabled={!p.enabled}
            >
              {p.manifest.name} {p.manifest.version}
              {p.enabled ? "" : ` · ${labels().Unavailable}`}
            </option>
          ))}
        </Select>
      </ListItem>
      {pkg &&
        Object.entries(pkg.manifest.fields)
          .filter(
            ([, field]) =>
              !field.when || config[field.when.field] === field.when.value,
          )
          .map(([name, field]) => {
            const update = (value: string) =>
              props.onChange({
                requestPlugin: {
                  ...binding!,
                  config: { ...config, [name]: value },
                },
              });
            return (
              <ListItem
                key={name}
                title={field.title}
                subTitle={field.description}
              >
                {field.type === "select" ? (
                  <Select
                    aria-label={field.title}
                    value={config[name]}
                    onChange={(event) => update(event.currentTarget.value)}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : field.type === "secret" ? (
                  <PasswordInput
                    aria-label={field.title}
                    value={config[name]}
                    onChange={(event) => update(event.currentTarget.value)}
                  />
                ) : (
                  <input
                    aria-label={field.title}
                    value={config[name]}
                    onChange={(event) => update(event.currentTarget.value)}
                  />
                )}
              </ListItem>
            );
          })}
      {pkg && (
        <ListItem
          title={labels().Preview}
          subTitle={labels().PreviewDescription}
        >
          <IconButton
            text={labels().Preview}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const session = createPluginSession(
                  props.endpoint,
                  "preview",
                  "chat",
                )!;
                const input = {
                  model: props.endpoint.models[0]?.name || "MODEL",
                  messages: [
                    { role: "user" as const, content: "Preview only" },
                  ],
                  stream: true,
                };
                const driver = await session.chat({
                  ...input,
                  enableTools: false,
                });
                const request =
                  driver ||
                  (await session.request(
                    buildEndpointRequest(props.endpoint, input),
                  ));
                const secrets = [
                  props.endpoint.apiKey,
                  ...Object.entries(pkg.manifest.fields)
                    .filter(([, field]) => field.type === "secret")
                    .map(([name]) => config[name]),
                ].filter(Boolean);
                const redact = (value: unknown): unknown => {
                  if (typeof value === "string")
                    return secrets.reduce(
                      (text, secret) => text.split(secret).join("[REDACTED]"),
                      value,
                    );
                  if (Array.isArray(value)) return value.map(redact);
                  if (value && typeof value === "object")
                    return Object.fromEntries(
                      Object.entries(value).map(([key, item]) => [
                        key,
                        /^(authorization|x-api-key|x-goog-api-key|apikey|token)$/i.test(
                          key,
                        )
                          ? "[REDACTED]"
                          : redact(item),
                      ]),
                    );
                  return value;
                };
                setPreview(
                  JSON.stringify(
                    redact({
                      kind: driver
                        ? "client-driver"
                        : request.transport
                        ? "independent-transport"
                        : "http-request",
                      ...(request.transport
                        ? { transportUrl: config.transportUrl }
                        : {}),
                      ...request,
                    }),
                    null,
                    2,
                  ),
                );
              } catch (error) {
                showToast(String(error));
              } finally {
                setBusy(false);
              }
            }}
          />
        </ListItem>
      )}
      {preview !== undefined && (
        <div className="modal-mask">
          <Modal title={labels().Preview} onClose={() => setPreview(undefined)}>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: "65vh",
                overflow: "auto",
              }}
            >
              {preview}
            </pre>
          </Modal>
        </div>
      )}
    </>
  );
}
