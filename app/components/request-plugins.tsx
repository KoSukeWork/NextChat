import { Fragment, useRef, useState } from "react";
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
import { LocalServiceControl } from "./local-service-control";
import { supportsLocalServices } from "../request-plugins/local-services";
import AddIcon from "../icons/add.svg";
import DownloadIcon from "../icons/download.svg";
import UploadIcon from "../icons/upload.svg";
import ClearIcon from "../icons/clear.svg";
import ConfirmIcon from "../icons/confirm.svg";
import styles from "./request-plugins.module.scss";

const labels = () => Locale.RequestPlugins;
const bundledClaudeVersion = "3.2.0-beta.1";

export function RequestPluginManager() {
  const config = useAppConfig();
  const upload = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const claudeAdded = config.requestPlugins.some(
    (pkg) =>
      pkg.manifest.id === "nextchat.claude-code" &&
      pkg.manifest.version === bundledClaudeVersion,
  );
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
      <ListItem title={labels().Title} subTitle={labels().Description} />
      <ListItem
        className={styles.row}
        title={labels().ClaudePlugin}
        subTitle={labels().ClaudePluginDescription}
      >
        <IconButton
          text={claudeAdded ? labels().Added : labels().Add}
          aria={labels().AddClaudePlugin}
          icon={claudeAdded ? <ConfirmIcon /> : <AddIcon />}
          bordered
          disabled={busy || claudeAdded}
          onClick={() =>
            void guarded(async () => {
              const response = await fetch(
                `./request-plugins/nextchat.claude-code-${bundledClaudeVersion}.json`,
              );
              if (!response.ok)
                throw new Error(`Package HTTP ${response.status}`);
              await install(await response.json());
            })
          }
        />
      </ListItem>
      <ListItem
        className={styles.row}
        title={labels().ImportTitle}
        subTitle={labels().ImportDescription}
      >
        <div className={styles.actions}>
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
            icon={<DownloadIcon />}
            bordered
            disabled={busy}
            onClick={() => upload.current?.click()}
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
            className={styles.row}
            key={`${id}@${version}`}
            title={`${name} · ${version}`}
            subTitle={`${id} · ${labels().Bound}: ${bound}`}
          >
            <div className={styles.actions}>
              <label className={styles.enabled}>
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
                <span>{labels().Enabled}</span>
              </label>
              <IconButton
                text={labels().Export}
                icon={<UploadIcon />}
                bordered
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
                icon={<ClearIcon />}
                bordered
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
  const localServices = (afterField?: string) =>
    pkg?.enabled &&
    supportsLocalServices() &&
    pkg.manifest.localServices
      ?.filter(
        (service) =>
          service.when?.field === afterField &&
          (!service.when || config[service.when.field] === service.when.value),
      )
      .map((service) => (
        <LocalServiceControl
          key={`${props.endpoint.id}:${pkg.manifest.id}@${pkg.manifest.version}:${service.id}`}
          service={service.id}
          title={service.title}
          onConnect={(connection) => {
            props.onChange({
              requestPlugin: {
                ...binding!,
                config: {
                  ...config,
                  [service.urlField]: connection.url,
                  [service.tokenField]: connection.token,
                  ...(service.versionField && connection.cliVersion
                    ? { [service.versionField]: connection.cliVersion }
                    : {}),
                },
              },
            });
          }}
        />
      ));
  return (
    <>
      <ListItem
        className={styles.field}
        title={labels().Select}
        subTitle={pkg?.manifest.description}
      >
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
      {localServices()}
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
              <Fragment key={name}>
                <ListItem
                  className={styles.field}
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
                      type="text"
                      aria-label={field.title}
                      value={config[name]}
                      onChange={(event) => update(event.currentTarget.value)}
                    />
                  )}
                </ListItem>
                {localServices(name)}
              </Fragment>
            );
          })}
      {pkg && (
        <ListItem
          className={styles.row}
          title={labels().Preview}
          subTitle={labels().PreviewDescription}
        >
          <IconButton
            text={labels().Preview}
            bordered
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
