/** @jest-environment node */
import { jest } from "@jest/globals";
import { ServiceLifecycle } from "../app/request-plugins/service-lifecycle";
import type { LocalServiceStatus } from "../app/request-plugins/local-services";

function fixture() {
  const live = new Map<string, LocalServiceStatus>();
  let serial = 0;
  const action = jest.fn(async (action: "start" | "stop", service: string) => {
    if (action === "stop") live.delete(service);
    else if (!live.has(service))
      live.set(service, {
        service,
        running: true,
        available: true,
        executablePath: "",
        canSelectExecutable: false,
        connection: {
          url: `http://127.0.0.1:${51000 + ++serial}`,
          token: `token-${serial}`,
        },
      });
    return (
      live.get(service) ?? {
        service,
        running: false,
        available: true,
        executablePath: "",
        canSelectExecutable: false,
      }
    );
  });
  return { live, action, manager: new ServiceLifecycle(action) };
}

test("a saved mode warms up on launch and is replaced without stopping in-flight users", async () => {
  const { manager, live } = fixture();
  await manager.reconcile(new Set(["wire"]));
  const [first, second] = await Promise.all([
    manager.acquire("wire"),
    manager.acquire("wire"),
  ]);
  expect(first.connection).toEqual(second.connection);
  await manager.reconcile(new Set(["claude-cli"]));
  expect([...live.keys()].sort()).toEqual(["claude-cli", "wire"]);
  await first.release();
  expect(live.has("wire")).toBe(true);
  await second.release();
  expect([...live.keys()]).toEqual(["claude-cli"]);
  await second.release(); // Idempotent release cannot steal another caller's lease.
  await manager.reconcile(new Set());
  expect(live.size).toBe(0);
});

test("another configured endpoint retains a shared service; manual stop recovers on the next request", async () => {
  const { manager, live } = fixture();
  await manager.reconcile(new Set(["wire", "claude-cli"]));
  const use = await manager.acquire("wire");
  await manager.reconcile(new Set(["wire"]));
  await expect(manager.stop("wire")).rejects.toThrow(/active requests/);
  await use.release();
  expect(live.has("wire")).toBe(true);
  await manager.stop("wire");
  expect(live.size).toBe(0);
  const restarted = await manager.acquire("wire");
  expect(restarted.connection.token).not.toBe(use.connection.token);
  await restarted.release();
  await manager.reconcile(new Set());
});

test("cancellation during startup does not block cancellation or leak an unused helper", async () => {
  const { action, live } = fixture();
  let ready!: () => void;
  let starting!: () => void;
  const begun = new Promise<void>((resolve) => (starting = resolve));
  const gate = new Promise<void>((resolve) => (ready = resolve));
  const manager = new ServiceLifecycle(async (method, service) => {
    if (method === "start") {
      starting();
      await gate;
    }
    return action(method, service);
  });
  const controller = new AbortController();
  const pending = manager.acquire("wire", controller.signal);
  await begun;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  ready();
  await manager.stop("wire"); // Queues behind the abandoned startup and cleanup.
  expect(live.size).toBe(0);
});

test("a startup failure can retry and a dead helper gets new connection credentials", async () => {
  const { action, live } = fixture();
  action.mockRejectedValueOnce(new Error("Missing component"));
  const manager = new ServiceLifecycle(action);
  await expect(manager.acquire("wire")).rejects.toThrow("Missing component");
  const first = await manager.acquire("wire");
  live.delete("wire");
  const next = await manager.acquire("wire");
  expect(next.connection.token).not.toBe(first.connection.token);
  await first.release();
  expect(live.has("wire")).toBe(true);
  await next.release();
  expect(live.size).toBe(0);
});

test("changing the saved mode while warmup is pending leaves only the latest service", async () => {
  const { action, live } = fixture();
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => (ready = resolve));
  const manager = new ServiceLifecycle(async (method, service) => {
    if (method === "start" && service === "wire") await gate;
    return action(method, service);
  });
  const first = manager.reconcile(new Set(["wire"]));
  await Promise.resolve();
  const changed = manager.reconcile(new Set(["claude-cli"]));
  ready();
  await Promise.all([first, changed]);
  expect([...live.keys()]).toEqual(["claude-cli"]);
  await manager.reconcile(new Set());
});
