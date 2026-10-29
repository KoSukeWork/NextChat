import { useState } from "react";
import { getClientApi, LLMModel } from "../client/api";
import { ModelDiscoveryUnsupportedError } from "../client/models";
import { ServiceProvider } from "../constant";
import { useAccessStore, useAppConfig } from "../store";
import { getModelProviderInfo } from "../utils/model";
import Locale from "../locales";
import { IconButton } from "./button";
import { List, ListItem, Modal, showToast } from "./ui-lib";
import { ModelManager } from "./model-manager";

export function ModelDiscovery() {
  const access = useAccessStore();
  const config = useAppConfig();
  const provider = access.useCustomConfig
    ? access.provider
    : ServiceProvider.OpenAI;
  const providerId = getModelProviderInfo(provider).id;
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<{
    provider: ServiceProvider;
    models: LLMModel[];
    selected: Set<string>;
  }>();
  const [search, setSearch] = useState("");
  const text = Locale.ModelDiscovery;
  const saved = config.models.filter((m) => m.provider.id === providerId);
  const visible =
    selection?.models.filter((m) =>
      m.name.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];

  async function discover() {
    setLoading(true);
    try {
      const models = await getClientApi(provider).llm.models();
      // Keep saved entries visible even when the provider no longer lists them.
      const existing = useAppConfig
        .getState()
        .models.filter((m) => m.provider.id === providerId);
      const byName = new Map([...existing, ...models].map((m) => [m.name, m]));
      setSearch("");
      setSelection({
        provider,
        models: [...byName.values()],
        selected: new Set(existing.map((m) => m.name)),
      });
    } catch (error) {
      showToast(
        error instanceof ModelDiscoveryUnsupportedError
          ? text.Unsupported
          : `${text.Failed}: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <ListItem
        title={text.Title}
        subTitle={`${provider} · ${text.Saved}: ${saved.length}`}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <IconButton
            text={loading ? text.Loading : text.Title}
            disabled={loading}
            onClick={discover}
            bordered
          />
          <ModelManager />
        </div>
      </ListItem>
      {selection && (
        <div className="modal-mask">
          <Modal
            title={`${selection.provider} · ${text.Title}`}
            onClose={() => setSelection(undefined)}
            actions={[
              <IconButton
                key="save"
                text={Locale.UI.Confirm}
                type="primary"
                onClick={() => {
                  config.setProviderModels(
                    getModelProviderInfo(selection.provider).id,
                    selection.models.filter((m) =>
                      selection.selected.has(m.name),
                    ),
                  );
                  setSelection(undefined);
                }}
              />,
            ]}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 16,
              }}
            >
              <input
                aria-label={text.Search}
                placeholder={text.Search}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              <IconButton
                text={text.SelectAll}
                bordered
                onClick={() =>
                  setSelection({
                    ...selection,
                    selected: new Set(selection.models.map((m) => m.name)),
                  })
                }
              />
              <IconButton
                text={text.SelectNone}
                bordered
                onClick={() =>
                  setSelection({ ...selection, selected: new Set() })
                }
              />
            </div>
            <div
              style={{ maxHeight: "50vh", overflowY: "auto", minWidth: 240 }}
            >
              {visible.length === 0 && <p>{text.Empty}</p>}
              <List>
                {visible.map((model) => (
                  <ListItem key={model.name} title={model.name}>
                    <input
                      type="checkbox"
                      aria-label={model.name}
                      checked={selection.selected.has(model.name)}
                      onChange={(e) => {
                        const selected = new Set(selection.selected);
                        if (e.currentTarget.checked) selected.add(model.name);
                        else selected.delete(model.name);
                        setSelection({ ...selection, selected });
                      }}
                    />
                  </ListItem>
                ))}
              </List>
            </div>
          </Modal>
        </div>
      )}
    </>
  );
}
