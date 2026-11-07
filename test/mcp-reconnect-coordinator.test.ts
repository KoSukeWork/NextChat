/** @jest-environment node */
import { jest } from "@jest/globals";
import { ReconnectCoordinator } from "../app/mcp/reconnect";

test("the overall limit aborts and releases a stuck reconnect", async () => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const coordinator = new ReconnectCoordinator(async (_ids, attemptSignal) => {
      signal = attemptSignal;
      await new Promise<void>(() => {});
    });
    const waiting = coordinator.reconnect(["stuck"]);
    await Promise.resolve();
    expect(coordinator.pendingIds()).toEqual(["stuck"]);
    await jest.advanceTimersByTimeAsync(59999);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(signal.aborted).toBe(true);
    expect(coordinator.pendingIds()).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});
