/** @jest-environment node */
import { jest } from "@jest/globals";

let responseBody = "NETWORK_REFUSED";
jest.unstable_mockModule("@fortaine/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: async (_url: string, options: any) => {
    await options.onopen(new Response(responseBody, { status: 599 }));
  },
}));
const { stream, streamWithThink } = await import("../app/utils/chat");
const { default: Locale } = await import("../app/locales");
Object.assign(globalThis, { requestAnimationFrame: () => 0 });

test.each(["plain", "thinking"] as const)(
  "%s legacy stream displays a safe network failure",
  async (kind) => {
    responseBody = "NETWORK_REFUSED";
    const result = await new Promise<string>((resolve) => {
      const options = { onFinish: (message: string) => resolve(message) };
      const common: [
        string,
        object,
        object,
        any[],
        Record<string, Function>,
        AbortController,
      ] = ["https://example.test", {}, {}, [], {}, new AbortController()];
      if (kind === "plain")
        stream(
          ...common,
          () => undefined,
          () => {},
          options,
        );
      else
        streamWithThink(
          ...common,
          () => ({ isThinking: false, content: undefined }),
          () => {},
          options,
        );
    });
    expect(result).toBe(Locale.Settings.Sync.Errors.NETWORK_REFUSED);
  },
);
