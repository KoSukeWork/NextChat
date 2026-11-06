import { ModalConfigValidator, ModelConfig } from "../store";

import Locale from "../locales";
import { InputRange } from "./input-range";
import { ListItem, Select } from "./ui-lib";
import { useAllModels } from "../utils/hooks";
import styles from "./model-config.module.scss";
import { useId } from "react";

type OptionalParameter =
  | "enableTemperature"
  | "enableTopP"
  | "enableMaxTokens"
  | "enablePresencePenalty"
  | "enableFrequencyPenalty";

export function ModelConfigList(props: {
  modelConfig: ModelConfig;
  updateConfig: (updater: (config: ModelConfig) => void) => void;
}) {
  const allModels = useAllModels();
  const effortListId = useId();
  const toggle = (key: OptionalParameter, title: string) => (
    <input
      type="checkbox"
      aria-label={Locale.Settings.EnableParameter(title)}
      checked={props.modelConfig[key] === true}
      onChange={(event) =>
        props.updateConfig((config) => {
          config[key] = event.currentTarget.checked;
        })
      }
    />
  );
  const value = JSON.stringify([
    props.modelConfig.endpointId,
    props.modelConfig.model,
  ]);
  const compressModelValue = props.modelConfig.compressModel
    ? JSON.stringify([
        props.modelConfig.compressEndpointId,
        props.modelConfig.compressModel,
      ])
    : "";

  return (
    <>
      <ListItem title={Locale.Settings.Model}>
        <Select
          aria-label={Locale.Settings.Model}
          value={value}
          align="left"
          onChange={(e) => {
            const [endpointId, model] = JSON.parse(e.currentTarget.value);
            props.updateConfig((config) => {
              config.model = ModalConfigValidator.model(model);
              config.endpointId = endpointId;
            });
          }}
        >
          {!allModels.length && (
            <option value={value}>{Locale.ModelDiscovery.Unconfigured}</option>
          )}
          {allModels.map((item) => (
            <option
              value={JSON.stringify([item.endpointId, item.name])}
              key={JSON.stringify([item.endpointId, item.name])}
            >
              {item.displayName} ({item.endpointName})
            </option>
          ))}
        </Select>
      </ListItem>
      <ListItem
        title={Locale.Settings.Temperature.Title}
        subTitle={Locale.Settings.JoinParameterDescriptions(
          Locale.Settings.Temperature.SubTitle,
          Locale.Settings.ParameterOptional,
        )}
      >
        <div className={styles["optional-parameter"]}>
          {toggle("enableTemperature", Locale.Settings.Temperature.Title)}
          <InputRange
            aria={Locale.Settings.Temperature.Title}
            value={props.modelConfig.temperature?.toFixed(1)}
            min="0"
            max="1" // lets limit it to 0-1
            step="0.1"
            disabled={props.modelConfig.enableTemperature !== true}
            onChange={(e) => {
              props.updateConfig(
                (config) =>
                  (config.temperature = ModalConfigValidator.temperature(
                    e.currentTarget.valueAsNumber,
                  )),
              );
            }}
          ></InputRange>
        </div>
      </ListItem>
      <ListItem
        title={Locale.Settings.TopP.Title}
        subTitle={Locale.Settings.JoinParameterDescriptions(
          Locale.Settings.TopP.SubTitle,
          Locale.Settings.ParameterOptional,
        )}
      >
        <div className={styles["optional-parameter"]}>
          {toggle("enableTopP", Locale.Settings.TopP.Title)}
          <InputRange
            aria={Locale.Settings.TopP.Title}
            value={(props.modelConfig.top_p ?? 1).toFixed(1)}
            min="0"
            max="1"
            step="0.1"
            disabled={props.modelConfig.enableTopP !== true}
            onChange={(e) => {
              props.updateConfig(
                (config) =>
                  (config.top_p = ModalConfigValidator.top_p(
                    e.currentTarget.valueAsNumber,
                  )),
              );
            }}
          ></InputRange>
        </div>
      </ListItem>
      <ListItem
        title={Locale.Settings.MaxTokens.Title}
        subTitle={Locale.Settings.JoinParameterDescriptions(
          Locale.Settings.MaxTokens.SubTitle,
          Locale.Settings.ParameterOptional,
          Locale.Settings.AnthropicMaxTokens,
        )}
      >
        <div className={styles["optional-parameter"]}>
          {toggle("enableMaxTokens", Locale.Settings.MaxTokens.Title)}
          <input
            aria-label={Locale.Settings.MaxTokens.Title}
            type="number"
            min={1024}
            max={512000}
            disabled={props.modelConfig.enableMaxTokens !== true}
            value={props.modelConfig.max_tokens}
            onChange={(e) =>
              props.updateConfig(
                (config) =>
                  (config.max_tokens = ModalConfigValidator.max_tokens(
                    e.currentTarget.valueAsNumber,
                  )),
              )
            }
          ></input>
        </div>
      </ListItem>
      <ListItem
        title={Locale.Settings.ReasoningEffort.Title}
        subTitle={Locale.Settings.ReasoningEffort.SubTitle}
      >
        <input
          type="text"
          aria-label={Locale.Settings.ReasoningEffort.Title}
          list={effortListId}
          value={props.modelConfig.reasoningEffort ?? ""}
          onChange={(event) =>
            props.updateConfig((config) => {
              config.reasoningEffort = event.currentTarget.value;
            })
          }
          onBlur={(event) =>
            props.updateConfig((config) => {
              config.reasoningEffort = event.currentTarget.value.trim();
            })
          }
        />
        <datalist id={effortListId}>
          {["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(
            (value) => (
              <option key={value} value={value} />
            ),
          )}
        </datalist>
      </ListItem>
      <ListItem
        title={Locale.Settings.ReasoningSummary.Title}
        subTitle={Locale.Settings.ReasoningSummary.SubTitle}
      >
        <input
          type="checkbox"
          aria-label={Locale.Settings.ReasoningSummary.Title}
          checked={props.modelConfig.enableReasoningSummary !== false}
          onChange={(event) =>
            props.updateConfig((config) => {
              config.enableReasoningSummary = event.currentTarget.checked;
            })
          }
        />
      </ListItem>

      {
        <>
          <ListItem
            title={Locale.Settings.PresencePenalty.Title}
            subTitle={Locale.Settings.JoinParameterDescriptions(
              Locale.Settings.PresencePenalty.SubTitle,
              Locale.Settings.ParameterOptional,
              Locale.Settings.PenaltyProtocols,
            )}
          >
            <div className={styles["optional-parameter"]}>
              {toggle(
                "enablePresencePenalty",
                Locale.Settings.PresencePenalty.Title,
              )}
              <InputRange
                aria={Locale.Settings.PresencePenalty.Title}
                value={props.modelConfig.presence_penalty?.toFixed(1)}
                min="-2"
                max="2"
                step="0.1"
                disabled={props.modelConfig.enablePresencePenalty !== true}
                onChange={(e) => {
                  props.updateConfig(
                    (config) =>
                      (config.presence_penalty =
                        ModalConfigValidator.presence_penalty(
                          e.currentTarget.valueAsNumber,
                        )),
                  );
                }}
              ></InputRange>
            </div>
          </ListItem>

          <ListItem
            title={Locale.Settings.FrequencyPenalty.Title}
            subTitle={Locale.Settings.JoinParameterDescriptions(
              Locale.Settings.FrequencyPenalty.SubTitle,
              Locale.Settings.ParameterOptional,
              Locale.Settings.PenaltyProtocols,
            )}
          >
            <div className={styles["optional-parameter"]}>
              {toggle(
                "enableFrequencyPenalty",
                Locale.Settings.FrequencyPenalty.Title,
              )}
              <InputRange
                aria={Locale.Settings.FrequencyPenalty.Title}
                value={props.modelConfig.frequency_penalty?.toFixed(1)}
                min="-2"
                max="2"
                step="0.1"
                disabled={props.modelConfig.enableFrequencyPenalty !== true}
                onChange={(e) => {
                  props.updateConfig(
                    (config) =>
                      (config.frequency_penalty =
                        ModalConfigValidator.frequency_penalty(
                          e.currentTarget.valueAsNumber,
                        )),
                  );
                }}
              ></InputRange>
            </div>
          </ListItem>

          <ListItem
            title={Locale.Settings.InjectSystemPrompts.Title}
            subTitle={Locale.Settings.InjectSystemPrompts.SubTitle}
          >
            <input
              aria-label={Locale.Settings.InjectSystemPrompts.Title}
              type="checkbox"
              checked={props.modelConfig.enableInjectSystemPrompts}
              onChange={(e) =>
                props.updateConfig(
                  (config) =>
                    (config.enableInjectSystemPrompts =
                      e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.InputTemplate.Title}
            subTitle={Locale.Settings.InputTemplate.SubTitle}
          >
            <input
              aria-label={Locale.Settings.InputTemplate.Title}
              type="text"
              value={props.modelConfig.template}
              onChange={(e) =>
                props.updateConfig(
                  (config) => (config.template = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>
        </>
      }
      <ListItem
        title={Locale.Settings.HistoryCount.Title}
        subTitle={Locale.Settings.HistoryCount.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.HistoryCount.Title}
          title={props.modelConfig.historyMessageCount.toString()}
          value={props.modelConfig.historyMessageCount}
          min="0"
          max="64"
          step="1"
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.historyMessageCount = e.target.valueAsNumber),
            )
          }
        ></InputRange>
      </ListItem>

      <ListItem
        title={Locale.Settings.CompressThreshold.Title}
        subTitle={Locale.Settings.CompressThreshold.SubTitle}
      >
        <input
          aria-label={Locale.Settings.CompressThreshold.Title}
          type="number"
          min={500}
          max={4000}
          value={props.modelConfig.compressMessageLengthThreshold}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.compressMessageLengthThreshold =
                  e.currentTarget.valueAsNumber),
            )
          }
        ></input>
      </ListItem>
      <ListItem title={Locale.Memory.Title} subTitle={Locale.Memory.Send}>
        <input
          aria-label={Locale.Memory.Title}
          type="checkbox"
          checked={props.modelConfig.sendMemory}
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.sendMemory = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.CompressModel.Title}
        subTitle={Locale.Settings.CompressModel.SubTitle}
      >
        <Select
          className={styles["select-compress-model"]}
          aria-label={Locale.Settings.CompressModel.Title}
          value={compressModelValue}
          onChange={(e) => {
            const [endpointId, model] = e.currentTarget.value
              ? JSON.parse(e.currentTarget.value)
              : ["", ""];
            props.updateConfig((config) => {
              config.compressModel = ModalConfigValidator.model(model);
              config.compressEndpointId = endpointId;
            });
          }}
        >
          <option value="">—</option>
          {allModels.map((item) => (
            <option
              value={JSON.stringify([item.endpointId, item.name])}
              key={JSON.stringify([item.endpointId, item.name])}
            >
              {item.displayName} ({item.endpointName})
            </option>
          ))}
        </Select>
      </ListItem>
    </>
  );
}
