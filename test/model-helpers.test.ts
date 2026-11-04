import { getTimeoutMSByModel } from "../app/utils";
import {
  REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS_FOR_THINKING,
} from "../app/constant";

describe("getTimeoutMSByModel", () => {
  test("uses the longer timeout for reasoning models", () => {
    const thinking = [
      "o1-preview",
      "o3-mini",
      "deepseek-reasoner",
      "glm-4-thinking",
    ];
    for (const model of thinking) {
      expect(getTimeoutMSByModel(model)).toBe(REQUEST_TIMEOUT_MS_FOR_THINKING);
    }
  });

  test("is case-insensitive", () => {
    expect(getTimeoutMSByModel("O1-PREVIEW")).toBe(
      REQUEST_TIMEOUT_MS_FOR_THINKING,
    );
  });

  test("uses the default timeout for regular chat models", () => {
    expect(getTimeoutMSByModel("gpt-4")).toBe(REQUEST_TIMEOUT_MS);
    expect(getTimeoutMSByModel("gpt-3.5-turbo")).toBe(REQUEST_TIMEOUT_MS);
    expect(getTimeoutMSByModel("claude-3-opus")).toBe(REQUEST_TIMEOUT_MS);
  });
});
