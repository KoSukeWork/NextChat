import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { jest } from "@jest/globals";
import Locale from "../app/locales";

jest.unstable_mockModule("../app/icons/down.svg", () => ({
  default: () => <svg />,
}));
const { ToolCard } = await import("../app/components/tool-card");
const { ThinkingBlock } = await import("../app/components/thinking");

test("tool cards are collapsed by default and retain service, arguments and error details", () => {
  const { container } = render(
    <ToolCard
      tool={{
        id: "c",
        function: { name: "wire", arguments: '{"query":"hello"}' },
        display: { source: "mcp", server: "测试服务", name: "search" },
        isError: true,
        content: "not found",
      }}
    />,
  );
  const button = screen.getByRole("button", { name: /测试服务 \/ search/ });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("测试服务 / search")).toBeInTheDocument();
  expect(screen.getByText(Locale.Chat.ToolCard.Failed)).toBeInTheDocument();
  expect(screen.queryByText(/not found/)).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/not found/)).toBeInTheDocument();
  expect(screen.getByText(/hello/)).toBeInTheDocument();
  expect(container.textContent).toContain(
    `${Locale.Chat.ToolCard.Server}${Locale.Chat.ToolCard.Separator}测试服务`,
  );
});

test("historical tool result cards have a name but no status label", () => {
  const { container } = render(
    <ToolCard
      historical
      tool={{
        id: "old",
        display: {
          source: "mcp",
          server: "remote",
          name: Locale.Chat.ToolCard.ToolResult,
        },
        content: "result",
      }}
    />,
  );
  expect(container.querySelector("button")?.textContent).toBe(
    `remote / ${Locale.Chat.ToolCard.ToolResult}`,
  );
});

test("thinking and tool cards use the same collapsible structure", () => {
  const { container } = render(
    <>
      <ThinkingBlock thinking={false}>thought</ThinkingBlock>
      <ToolCard
        tool={{
          id: "shared",
          function: { name: "lookup" },
          content: "result",
          isError: false,
        }}
      />
    </>,
  );
  const buttons = container.querySelectorAll("button");
  expect(buttons[0].className).toBe(buttons[1].className);
  expect(buttons[0].parentElement?.className).toBe(
    buttons[1].parentElement?.className,
  );
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(buttons[0].nextElementSibling?.className).toBe(
    buttons[1].nextElementSibling?.className,
  );
  expect(screen.getByText("thought")).toBeVisible();
  expect(screen.getByText("result")).toBeVisible();
});

test("an unfinished tool is shown as stopped when its message stops", () => {
  const tool = { id: "pending", function: { name: "slow" } };
  const { rerender } = render(<ToolCard tool={tool} active />);
  expect(screen.getByText(Locale.Chat.ToolCard.Running)).toBeInTheDocument();

  rerender(<ToolCard tool={tool} active={false} />);
  expect(screen.getByText(Locale.Chat.ToolCard.Stopped)).toBeInTheDocument();
  expect(
    screen.queryByText(Locale.Chat.ToolCard.Running),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(Locale.Chat.ToolCard.Result),
  ).not.toBeInTheDocument();

  rerender(<ToolCard tool={{ ...tool, isError: false }} active={false} />);
  expect(screen.getByText(Locale.Chat.ToolCard.Succeeded)).toBeInTheDocument();

  rerender(<ToolCard tool={tool} historical active={false} />);
  expect(
    screen.queryByText(Locale.Chat.ToolCard.Stopped),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(Locale.Chat.ToolCard.Running),
  ).not.toBeInTheDocument();
});
