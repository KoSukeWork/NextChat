import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { jest } from "@jest/globals";
import "../app/client/api";
import Locale from "../app/locales";

jest.unstable_mockModule("../app/icons/down.svg", () => ({
  default: () => <svg />,
}));
const { ThinkingBlock } = await import("../app/components/thinking");

test("thoughts start collapsed, can open while streaming and stay open after completion", () => {
  const { rerender } = render(
    <ThinkingBlock thinking>Live thought</ThinkingBlock>,
  );
  const button = screen.getByRole("button", {
    name: Locale.Chat.Thinking.Active,
  });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Live thought")).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.getByText("Live thought")).toBeVisible();
  rerender(<ThinkingBlock thinking={false}>Complete thought</ThinkingBlock>);
  expect(
    screen.getByRole("button", { name: Locale.Chat.Thinking.Done }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Complete thought")).toBeVisible();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.queryByText("Complete thought")).not.toBeInTheDocument();
});
