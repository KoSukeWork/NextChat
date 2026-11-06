import { useState } from "react";
import { nanoid } from "nanoid";
import { fetchEndpointModels } from "../client/endpoint-models";
import Locale from "../locales";
import { useAppConfig } from "../store/config";
import { endpointProtocols, endpointUrl } from "../utils/endpoints";
import type {
  Endpoint,
  EndpointModel,
  EndpointProtocol,
} from "../utils/endpoints";
import { IconButton } from "./button";
import {
  List,
  ListItem,
  Modal,
  PasswordInput,
  Select,
  showConfirm,
  showToast,
} from "./ui-lib";
import styles from "./endpoint-config.module.scss";

const protocolNames: Record<EndpointProtocol, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
};

function EndpointEditor(props: { initial: Endpoint; onClose: () => void }) {
  const config = useAppConfig();
  const [draft, setDraft] = useState<Endpoint>(() => ({
    ...props.initial,
    models: [...props.initial.models],
  }));
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [found, setFound] = useState<EndpointModel[]>([]);
  const [selectedFound, setSelectedFound] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const update = (changes: Partial<Endpoint>) =>
    setDraft((current) => ({ ...current, ...changes }));
  const toggle = (items: string[], value: string) =>
    items.includes(value)
      ? items.filter((item) => item !== value)
      : [...items, value];
  let preview = "—";
  try {
    preview = endpointUrl(draft, "chat", draft.models[0]?.name ?? "MODEL");
  } catch {}

  const save = () => {
    try {
      if (!draft.name.trim()) throw new Error();
      endpointUrl(draft, "models");
    } catch {
      showToast(Locale.EndpointConfig.Invalid);
      return;
    }
    const saved = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
    };
    config.update((state) => {
      const index = state.endpoints.findIndex(
        (endpoint) => endpoint.id === saved.id,
      );
      if (index < 0) state.endpoints.push(saved);
      else state.endpoints[index] = saved;
      const selected = state.endpoints.find(
        (endpoint) =>
          endpoint.id === state.modelConfig.endpointId &&
          endpoint.models.some(
            (model) => model.name === state.modelConfig.model,
          ),
      );
      if (!selected) {
        const first = state.endpoints.find(
          (endpoint) => endpoint.models.length,
        );
        state.modelConfig.model = first?.models[0]?.name ?? "";
        state.modelConfig.endpointId = first?.id ?? "";
      }
    });
    props.onClose();
  };
  const addModels = (models: EndpointModel[]) =>
    setDraft((current) => {
      const existing = new Set(current.models.map((model) => model.name));
      return {
        ...current,
        models: [
          ...current.models,
          ...models.filter((model) => model.name && !existing.has(model.name)),
        ],
      };
    });

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.EndpointConfig.Edit}
        onClose={props.onClose}
        actions={[
          <IconButton
            key="save"
            text={Locale.EndpointConfig.Save}
            bordered
            onClick={save}
          />,
        ]}
      >
        <List>
          <ListItem title={Locale.EndpointConfig.Name}>
            <input
              aria-label={Locale.EndpointConfig.Name}
              value={draft.name}
              onChange={(event) => update({ name: event.currentTarget.value })}
            />
          </ListItem>
          <ListItem title={Locale.EndpointConfig.Protocol}>
            <Select
              aria-label={Locale.EndpointConfig.Protocol}
              value={draft.protocol}
              onChange={(event) =>
                update({
                  protocol: event.currentTarget.value as EndpointProtocol,
                })
              }
            >
              {endpointProtocols.map((protocol) => (
                <option key={protocol} value={protocol}>
                  {protocolNames[protocol]}
                </option>
              ))}
            </Select>
          </ListItem>
          <ListItem title={Locale.EndpointConfig.ToolCalling}>
            <Select
              aria-label={Locale.EndpointConfig.ToolCalling}
              value={draft.toolCalling ?? "auto"}
              onChange={(event) =>
                update({
                  toolCalling: event.currentTarget.value as "auto" | "text",
                })
              }
            >
              <option value="auto">
                {Locale.EndpointConfig.ToolCallingAuto}
              </option>
              <option value="text">
                {Locale.EndpointConfig.ToolCallingText}
              </option>
            </Select>
          </ListItem>
          <ListItem title={Locale.EndpointConfig.BaseUrl}>
            <input
              aria-label={Locale.EndpointConfig.BaseUrl}
              value={draft.baseUrl}
              placeholder="https://api.example.com"
              onChange={(event) =>
                update({ baseUrl: event.currentTarget.value })
              }
            />
          </ListItem>
          <ListItem title={Locale.EndpointConfig.ApiKey}>
            <PasswordInput
              aria-label={Locale.EndpointConfig.ApiKey}
              value={draft.apiKey}
              onChange={(event) =>
                update({ apiKey: event.currentTarget.value })
              }
            />
          </ListItem>
          <ListItem
            title={Locale.EndpointConfig.RequestUrl}
            subTitle={preview}
          />
        </List>
        <List>
          <ListItem
            title={Locale.EndpointConfig.Models}
            subTitle={
              draft.models.length
                ? `${draft.models.length}`
                : Locale.EndpointConfig.NoModels
            }
          >
            <IconButton
              text={Locale.EndpointConfig.DeleteSelected}
              disabled={!selected.length}
              onClick={() => {
                update({
                  models: draft.models.filter(
                    (model) => !selected.includes(model.name),
                  ),
                });
                setSelected([]);
              }}
            />
          </ListItem>
          {draft.models.map((model) => (
            <ListItem
              key={model.name}
              title={model.displayName || model.name}
              subTitle={model.displayName ? model.name : undefined}
            >
              <input
                type="checkbox"
                aria-label={model.name}
                checked={selected.includes(model.name)}
                onChange={() => setSelected(toggle(selected, model.name))}
              />
            </ListItem>
          ))}
          <ListItem title={Locale.EndpointConfig.AddModel} vertical>
            <div className={styles["model-entry"]}>
              <input
                aria-label={Locale.EndpointConfig.ModelName}
                value={name}
                placeholder={Locale.EndpointConfig.ModelName}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <input
                aria-label={Locale.EndpointConfig.DisplayName}
                value={displayName}
                placeholder={Locale.EndpointConfig.DisplayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
              <IconButton
                text={Locale.EndpointConfig.AddModel}
                disabled={!name.trim()}
                onClick={() => {
                  addModels([
                    {
                      name: name.trim(),
                      ...(displayName.trim()
                        ? { displayName: displayName.trim() }
                        : {}),
                    },
                  ]);
                  setName("");
                  setDisplayName("");
                }}
              />
            </div>
          </ListItem>
          <ListItem title={Locale.EndpointConfig.FetchModels}>
            <IconButton
              text={Locale.EndpointConfig.FetchModels}
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  setFound(await fetchEndpointModels(draft));
                  setSelectedFound([]);
                } catch (error) {
                  showToast(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  setLoading(false);
                }
              }}
            />
          </ListItem>
          {found.map((model) => (
            <ListItem
              key={model.name}
              title={model.displayName || model.name}
              subTitle={model.displayName ? model.name : undefined}
            >
              <input
                type="checkbox"
                aria-label={`${Locale.EndpointConfig.AddModel}: ${model.name}`}
                checked={selectedFound.includes(model.name)}
                onChange={() =>
                  setSelectedFound(toggle(selectedFound, model.name))
                }
              />
            </ListItem>
          ))}
          {found.length > 0 && (
            <ListItem title={Locale.EndpointConfig.AddSelected}>
              <IconButton
                text={Locale.EndpointConfig.AddSelected}
                disabled={!selectedFound.length}
                onClick={() => {
                  addModels(
                    found.filter((model) => selectedFound.includes(model.name)),
                  );
                  setFound([]);
                  setSelectedFound([]);
                }}
              />
            </ListItem>
          )}
        </List>
      </Modal>
    </div>
  );
}

export function EndpointConfigList() {
  const config = useAppConfig();
  const [editing, setEditing] = useState<Endpoint>();
  return (
    <>
      <List>
        <ListItem title={Locale.EndpointConfig.Title}>
          <IconButton
            text={Locale.EndpointConfig.Add}
            bordered
            onClick={() =>
              setEditing({
                id: nanoid(),
                name: "",
                protocol: "openai-chat",
                baseUrl: "",
                apiKey: "",
                models: [],
              })
            }
          />
        </ListItem>
        {config.endpoints.map((endpoint) => (
          <ListItem
            key={endpoint.id}
            title={endpoint.name}
            subTitle={`${protocolNames[endpoint.protocol]} · ${
              endpoint.baseUrl
            } · ${endpoint.models.length}`}
          >
            <div className={styles.actions}>
              <IconButton
                text={Locale.UI.Edit}
                onClick={() => setEditing(endpoint)}
              />
              <IconButton
                text={Locale.EndpointConfig.Delete}
                type="danger"
                onClick={async () => {
                  const isDefault =
                    config.modelConfig.endpointId === endpoint.id &&
                    endpoint.models.some(
                      (model) => model.name === config.modelConfig.model,
                    );
                  if (
                    !(await showConfirm(
                      Locale.EndpointConfig.Remove(
                        endpoint.name,
                        endpoint.models.length,
                        isDefault,
                      ),
                    ))
                  )
                    return;
                  config.update((state) => {
                    state.endpoints = state.endpoints.filter(
                      (item) => item.id !== endpoint.id,
                    );
                    if (state.modelConfig.endpointId === endpoint.id) {
                      const first = state.endpoints.find(
                        (item) => item.models.length,
                      );
                      state.modelConfig.endpointId = first?.id ?? "";
                      state.modelConfig.model = first?.models[0]?.name ?? "";
                    }
                  });
                }}
              />
            </div>
          </ListItem>
        ))}
      </List>
      {editing && (
        <EndpointEditor
          initial={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
