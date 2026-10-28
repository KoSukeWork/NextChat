import {
  collectModelTableWithDefaultModel,
  collectModelsWithDefaultModel,
} from "../app/utils/model";
const models = ["gpt-4", "gpt-3.5-turbo"].map((name, sorted) => ({
  name,
  sorted,
  available: true,
  provider: {
    id: "openai",
    providerName: "OpenAI",
    providerType: "openai",
    sorted: 1,
  },
}));

describe("collectModelTableWithDefaultModel", () => {
  test("marks a fully-qualified default model (name@provider) as default", () => {
    const table = collectModelTableWithDefaultModel(models, "", "gpt-4@openai");
    expect(table["gpt-4@openai"].isDefault).toBe(true);
  });

  test("marks the first available match when the default omits the provider", () => {
    const table = collectModelTableWithDefaultModel(
      models,
      "",
      "gpt-3.5-turbo",
    );
    expect(table["gpt-3.5-turbo@openai"].isDefault).toBe(true);
  });

  test("flags exactly one model as default", () => {
    const table = collectModelTableWithDefaultModel(models, "", "gpt-4@openai");
    expect(Object.values(table).filter((m) => m.isDefault)).toHaveLength(1);
  });

  test("leaves every model un-flagged when defaultModel is empty", () => {
    const table = collectModelTableWithDefaultModel(models, "", "");
    expect(Object.values(table).some((m) => m.isDefault)).toBe(false);
  });
});

describe("collectModelsWithDefaultModel", () => {
  test("returns the model list with exactly the chosen default flagged", () => {
    const result = collectModelsWithDefaultModel(models, "", "gpt-4@openai");
    const defaults = result.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("gpt-4");
  });
});
