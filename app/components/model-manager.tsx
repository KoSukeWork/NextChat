import { useState } from "react";
import type { LLMModel } from "../client/api";
import { useAppConfig } from "../store/config";
import Locale from "../locales";
import { IconButton } from "./button";
import { List, ListItem, Modal, showConfirm } from "./ui-lib";

export const savedModelKey = (model: LLMModel) =>
  JSON.stringify([model.provider.id, model.name]);

export function ModelManager() {
  const config = useAppConfig();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const text = Locale.ModelManager;
  const isDefault = (model: LLMModel) =>
    model.name === config.modelConfig.model &&
    model.provider.providerName === config.modelConfig.providerName;
  const groups = new Map<string, LLMModel[]>();
  for (const model of config.models) {
    const group = groups.get(model.provider.id) ?? [];
    group.push(model);
    groups.set(model.provider.id, group);
  }
  const selectedCount = config.models.filter((model) =>
    selected.has(savedModelKey(model)),
  ).length;
  async function remove(keys: Set<string>) {
    const current = useAppConfig.getState();
    const targets = current.models.filter((model) =>
      keys.has(savedModelKey(model)),
    );
    if (!targets.length) return;
    const deletesDefault = targets.some(
      (model) =>
        model.name === current.modelConfig.model &&
        model.provider.providerName === current.modelConfig.providerName,
    );
    if (
      !(await showConfirm(
        <div>
          <p>{text.Confirm(targets.length)}</p>
          {deletesDefault && <p>{text.DefaultWarning}</p>}
        </div>,
      ))
    )
      return;
    useAppConfig.getState().removeSavedModels([...keys]);
    setSelected(
      (previous) => new Set([...previous].filter((key) => !keys.has(key))),
    );
  }
  const query = search.trim().toLowerCase();
  const visibleGroups = [...groups]
    .map(([id, models]) => ({
      id,
      models,
      visible: models.filter((model) =>
        [model.name, model.displayName ?? "", model.provider.providerName].some(
          (value) => value.toLowerCase().includes(query),
        ),
      ),
    }))
    .filter((group) => group.visible.length);
  return (
    <>
      <IconButton
        text={text.Title}
        bordered
        onClick={() => {
          setSearch("");
          setSelected(new Set());
          setOpen(true);
        }}
      />
      {open && (
        <div className="modal-mask">
          <Modal
            title={text.Title}
            onClose={() => setOpen(false)}
            actions={[
              <IconButton
                key="delete"
                text={text.DeleteSelected(selectedCount)}
                disabled={!selectedCount}
                onClick={() => remove(selected)}
                bordered
              />,
              <IconButton
                key="close"
                text={Locale.UI.Close}
                onClick={() => setOpen(false)}
              />,
            ]}
          >
            <p>{text.CustomHint}</p>
            <input
              aria-label={text.Search}
              placeholder={text.Search}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginBottom: 12,
              }}
            />
            <div
              style={{ maxHeight: "55vh", overflowY: "auto", minWidth: 260 }}
            >
              {!visibleGroups.length && <p>{text.Empty}</p>}
              {visibleGroups.map(({ id, models, visible }) => (
                <section key={id} aria-label={models[0].provider.providerName}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <h3>
                      {models[0].provider.providerName} ({models.length})
                    </h3>
                    <IconButton
                      text={text.ClearProvider(models.length)}
                      aria={`${
                        models[0].provider.providerName
                      }: ${text.ClearProvider(models.length)}`}
                      bordered
                      onClick={() => remove(new Set(models.map(savedModelKey)))}
                    />
                  </div>
                  <List>
                    {visible.map((model, index) => (
                      <ListItem
                        key={`${savedModelKey(model)}-${index}`}
                        title={model.displayName || model.name}
                        subTitle={`${model.name}${
                          isDefault(model) ? ` · ${text.Default}` : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${model.provider.providerName}: ${model.name}`}
                          checked={selected.has(savedModelKey(model))}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.currentTarget.checked)
                              next.add(savedModelKey(model));
                            else next.delete(savedModelKey(model));
                            setSelected(next);
                          }}
                        />
                        <IconButton
                          text={text.Delete}
                          aria={`${text.Delete}: ${model.provider.providerName}: ${model.name}`}
                          bordered
                          onClick={() =>
                            remove(new Set([savedModelKey(model)]))
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                </section>
              ))}
            </div>
          </Modal>
        </div>
      )}
    </>
  );
}
