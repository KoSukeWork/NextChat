import React, { useState } from "react";
import { jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
for (const icon of ["close", "confirm", "cancel", "max", "min", "down"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
const { ModelConfigList } = await import("../app/components/model-config");
const { DEFAULT_CONFIG } = await import("../app/store/config");
const Locale = (await import("../app/locales")).default;

test("optional controls retain their values and reasoning summary defaults on", () => {
  function Example() {
    const [config, setConfig] = useState({ ...DEFAULT_CONFIG.modelConfig });
    return (
      <ModelConfigList
        modelConfig={config}
        updateConfig={(update) => {
          const next = { ...config };
          update(next);
          setConfig(next);
        }}
      />
    );
  }
  const { container } = render(<Example />);
  const labels = Locale.Settings;
  const temperature = screen.getByLabelText(labels.Temperature.Title);
  const toggle = screen.getByLabelText(
    labels.EnableParameter(labels.Temperature.Title),
  );
  expect(temperature).toBeDisabled();
  expect(temperature.parentElement).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByLabelText(labels.ReasoningSummary.Title)).toBeChecked();
  fireEvent.click(toggle);
  expect(temperature).toBeEnabled();
  expect(temperature.parentElement).not.toHaveAttribute("aria-disabled");
  fireEvent.change(temperature, { target: { value: "0.8" } });
  fireEvent.click(toggle);
  expect(temperature).toBeDisabled();
  expect(temperature).toHaveValue("0.8");
  const effort = screen.getByLabelText(labels.ReasoningEffort.Title);
  fireEvent.change(effort, { target: { value: " HiGh " } });
  fireEvent.blur(effort);
  expect(effort).toHaveValue("HiGh");
  expect(
    Array.from(
      container.querySelectorAll<HTMLOptionElement>("datalist option"),
    ).map((option) => option.value),
  ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("parameter descriptions use the punctuation of the selected language", async () => {
  const cn = (await import("../app/locales/cn")).default;
  const en = (await import("../app/locales/en")).default;
  expect(
    cn.Settings.JoinParameterDescriptions(
      cn.Settings.Temperature.SubTitle,
      cn.Settings.ParameterOptional,
    ),
  ).toBe("值越大，回复越随机。关闭时不发送，使用模型默认值。");
  expect(en.Settings.JoinParameterDescriptions("First", "Second.")).toBe(
    "First. Second.",
  );
});
