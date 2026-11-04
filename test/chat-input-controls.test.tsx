import React from "react";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

for (const icon of ["send-white", "pause"])
  jest.unstable_mockModule(`@/app/icons/${icon}.svg`, () => ({
    default: () => <svg />,
  }));

const { ChatControllerPool } = await import("../app/client/controller");
const { ChatInputControls } = await import(
  "../app/components/chat-input-controls"
);
const Locale = (await import("../app/locales")).default;

afterEach(() => {
  cleanup();
  for (const [sessionId, controllers] of ChatControllerPool.controllers) {
    for (const messageId of controllers.keys()) {
      ChatControllerPool.remove(sessionId, messageId);
    }
  }
});

test("the send control follows the current conversation and preserves concurrent sends", () => {
  const onSend = jest.fn();
  const props = {
    sessionId: "a",
    input: "",
    hasImages: false,
    uploading: false,
    onSend,
  };
  const { rerender } = render(<ChatInputControls {...props} />);
  expect(
    screen.getByRole("button", { name: Locale.Chat.Send }),
  ).toBeInTheDocument();
  const a = new AbortController();
  const b = new AbortController();
  act(() => {
    ChatControllerPool.addController("a", "1", a);
    ChatControllerPool.addController("b", "1", b);
  });
  expect(
    screen.getByRole("button", { name: Locale.Chat.InputActions.Stop }),
  ).toBeInTheDocument();

  rerender(<ChatInputControls {...props} input="another message" />);
  fireEvent.click(screen.getByRole("button", { name: Locale.Chat.Send }));
  expect(onSend).toHaveBeenCalledTimes(1);
  rerender(<ChatInputControls {...props} hasImages />);
  expect(
    screen.getByRole("button", { name: Locale.Chat.Send }),
  ).toBeInTheDocument();

  rerender(<ChatInputControls {...props} uploading />);
  const uploadingButton = screen.getByRole("button", { name: Locale.Chat.Send });
  expect(uploadingButton).toBeDisabled();
  fireEvent.click(uploadingButton);
  expect(onSend).toHaveBeenCalledTimes(1);

  rerender(<ChatInputControls {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: Locale.Chat.InputActions.Stop }),
  );
  expect(a.signal.aborted).toBe(true);
  expect(b.signal.aborted).toBe(false);
  act(() => ChatControllerPool.remove("a", "1"));
  expect(
    screen.getByRole("button", { name: Locale.Chat.Send }),
  ).toBeInTheDocument();
  expect(ChatControllerPool.hasPending("b")).toBe(true);
  rerender(<ChatInputControls {...props} sessionId="b" />);
  expect(
    screen.getByRole("button", { name: Locale.Chat.InputActions.Stop }),
  ).toBeInTheDocument();
});
