/** @jest-environment node */
import { jest } from "@jest/globals";
import { ReconnectBackoff, ReconnectCoordinator } from "../app/mcp/reconnect";

test("backoff grows per server, caps at five minutes, and resets", () => {
  jest.useFakeTimers();
  try {
    const backoff = new ReconnectBackoff();
    for (const seconds of [30, 60, 120, 240, 300, 300]) {
      backoff.recordFailure("a");
      expect(backoff.inCooldown("a")).toBe(true);
      expect(backoff.inCooldown("b")).toBe(false);
      jest.advanceTimersByTime(seconds * 1000 - 1);
      expect(backoff.inCooldown("a")).toBe(true);
      jest.advanceTimersByTime(1);
      expect(backoff.inCooldown("a")).toBe(false);
    }
    backoff.reset("a");
    backoff.recordFailure("a");
    jest.advanceTimersByTime(30_000);
    expect(backoff.inCooldown("a")).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test("message attempts respect cooldown while forced attempts bypass and extend it", async () => {
  jest.useFakeTimers();
  try {
    let attempts = 0;
    let succeeds = false;
    const coordinator = new ReconnectCoordinator(async () => {
      attempts++;
      return succeeds ? "success" : "failure";
    });
    await coordinator.reconnect(["a"], "message");
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(1);
    jest.advanceTimersByTime(29_999);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(1);
    jest.advanceTimersByTime(1);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(2);
    jest.advanceTimersByTime(30_000);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(2);
    await coordinator.reconnect(["a"], "force");
    expect(attempts).toBe(3);
    jest.advanceTimersByTime(119_999);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(3);
    succeeds = true;
    await coordinator.reconnect(["a"], "force");
    expect(attempts).toBe(4);
    succeeds = false;
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(5);
    jest.advanceTimersByTime(30_000);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(6);
  } finally {
    jest.useRealTimers();
  }
});

test("a message waits only once for a slow flight; forced callers still wait", async () => {
  jest.useFakeTimers();
  try {
    let finish!: (result: "failure") => void;
    let attempts = 0;
    const coordinator = new ReconnectCoordinator(async () => {
      attempts++;
      return new Promise<"failure">((resolve) => { finish = resolve; });
    });
    const first = coordinator.reconnect(["a"], "message");
    await jest.advanceTimersByTimeAsync(3000);
    await first;
    expect(coordinator.pendingIds()).toEqual(["a"]);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(1);
    let forcedFinished = false;
    const forced = coordinator.reconnect(["a"], "force").then(() => { forcedFinished = true; });
    await Promise.resolve();
    expect(forcedFinished).toBe(false);
    finish("failure");
    await forced;
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(1);
    jest.advanceTimersByTime(30_000);
    const next = coordinator.reconnect(["a"], "message");
    await Promise.resolve();
    expect(attempts).toBe(2);
    finish("failure");
    await next;
    jest.advanceTimersByTime(30_000);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test("a cancelled flight never records a failure, including a late result", async () => {
  jest.useFakeTimers();
  try {
    let finish!: (result: "failure") => void;
    let attempts = 0;
    const coordinator = new ReconnectCoordinator(async () => {
      attempts++;
      if (attempts === 1) return new Promise<"failure">((resolve) => { finish = resolve; });
      return "failure";
    });
    const first = coordinator.reconnect(["a"], "message");
    await jest.advanceTimersByTimeAsync(3000);
    await first;
    coordinator.cancel("a");
    finish("failure");
    await jest.advanceTimersByTimeAsync(0);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(2);
    jest.advanceTimersByTime(30_000);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test("a forced slow success clears earlier failures once the background flight finishes", async () => {
  jest.useFakeTimers();
  try {
    let attempts = 0;
    let finish!: (result: "success") => void;
    const coordinator = new ReconnectCoordinator(async () => {
      attempts++;
      if (attempts === 2) return new Promise<"success">((resolve) => { finish = resolve; });
      return "failure";
    });
    await coordinator.reconnect(["a"], "message");
    const forced = coordinator.reconnect(["a"], "force");
    await jest.advanceTimersByTimeAsync(3000);
    await forced;
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(2);
    finish("success");
    await jest.advanceTimersByTimeAsync(0);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(3);
    jest.advanceTimersByTime(30_000);
    await coordinator.reconnect(["a"], "message");
    expect(attempts).toBe(4);
  } finally {
    jest.useRealTimers();
  }
});

test("a skipped reconnect does not start a cooldown", async () => {
  let attempts = 0;
  const coordinator = new ReconnectCoordinator(async () => {
    attempts++;
    return "skipped";
  });
  await coordinator.reconnect(["a"], "message");
  await coordinator.reconnect(["a"], "message");
  expect(attempts).toBe(2);
});

test("the overall limit aborts and releases a stuck reconnect", async () => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    let attempts = 0;
    const coordinator = new ReconnectCoordinator(async (_ids, attemptSignal) => {
      attempts++;
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
    await coordinator.reconnect(["stuck"], "message");
    expect(attempts).toBe(1);
    jest.advanceTimersByTime(30_000);
    const next = coordinator.reconnect(["stuck"], "message");
    await Promise.resolve();
    expect(attempts).toBe(2);
    coordinator.cancel("stuck");
    await next;
  } finally {
    jest.useRealTimers();
  }
});
