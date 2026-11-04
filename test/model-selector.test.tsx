import React from "react";
import { jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

for (const icon of [
  "three-dots",
  "close",
  "eye",
  "eye-off",
  "down",
  "confirm",
  "cancel",
  "max",
  "min",
]) {
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));
}
jest.unstable_mockModule("@/app/components/emoji", () => ({
  Avatar: () => <span />,
}));

const { Selector } = await import("../app/components/ui-lib");

afterEach(cleanup);

test("model selector preserves subtitle search and selection", () => {
  const onSelection = jest.fn();
  const onClose = jest.fn();
  const longName = "model".repeat(30);
  render(
    <Selector
      layout="model"
      searchPlaceholder="Search models"
      defaultSelectedValue="one"
      items={[
        { title: "Normal model", subTitle: "Endpoint A", value: "one" },
        {
          title: longName,
          subTitle: "Endpoint B",
          searchText: "hidden-model-id",
          value: "two",
        },
      ]}
      onSelection={onSelection}
      onClose={onClose}
    />,
  );

  expect(screen.getByText("Normal model")).toBeInTheDocument();
  expect(screen.getByText("Endpoint A")).toBeInTheDocument();
  const search = screen.getByRole("textbox", { name: "Search models" });
  fireEvent.change(search, { target: { value: "Endpoint B" } });
  expect(screen.getByText(longName)).toBeInTheDocument();
  expect(screen.queryByText("Normal model")).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "hidden-model-id" } });
  fireEvent.click(screen.getByText(longName));
  expect(onSelection).toHaveBeenCalledWith(["two"]);
  expect(onClose).toHaveBeenCalled();
});

test("plugin selector retains multiple selection and close behavior", () => {
  const onSelection = jest.fn();
  const onClose = jest.fn();
  const { container } = render(
    <Selector
      multiple
      defaultSelectedValue={["a"]}
      items={[
        { title: "Plugin A", value: "a" },
        { title: "Plugin B", value: "b" },
      ]}
      onSelection={onSelection}
      onClose={onClose}
    />,
  );

  fireEvent.click(screen.getByText("Plugin B"));
  expect(onSelection).toHaveBeenCalledWith(["a", "b"]);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Plugin A"));
  expect(onSelection).toHaveBeenLastCalledWith(["b"]);
  fireEvent.click(container.firstElementChild!);
  expect(onClose).toHaveBeenCalledTimes(1);
});
