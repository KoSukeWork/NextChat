import type {
  LocalServiceConnection,
  LocalServiceStatus,
} from "./local-services";

export interface ServiceLease {
  connection: LocalServiceConnection;
  release(): Promise<void>;
}

type Slot = {
  required: boolean;
  paused: boolean;
  users: number;
  readyUsers: number;
  generation: number;
  queue: Promise<unknown>;
};

/** Serializes lifecycle changes while callers hold a lease for their full stream. */
export class ServiceLifecycle {
  private slots = new Map<string, Slot>();
  constructor(
    private action: (
      action: "start" | "stop",
      service: string,
      executablePath?: string,
    ) => Promise<LocalServiceStatus>,
    private connected: (
      service: string,
      connection: LocalServiceConnection,
    ) => void = () => {},
  ) {}

  private slot(service: string) {
    let slot = this.slots.get(service);
    if (!slot) {
      slot = {
        required: false,
        paused: false,
        users: 0,
        readyUsers: 0,
        generation: 0,
        queue: Promise.resolve(),
      };
      this.slots.set(service, slot);
    }
    return slot;
  }

  private enqueue<T>(slot: Slot, task: () => Promise<T>): Promise<T> {
    const next = slot.queue.then(task, task);
    slot.queue = next.catch(() => {});
    return next;
  }

  private async start(service: string, executablePath?: string) {
    const status = await this.action("start", service, executablePath);
    if (!status.running || !status.connection)
      throw new Error(status.error || "Local service did not become ready");
    this.connected(service, status.connection);
    return status.connection;
  }

  private idle(service: string, slot: Slot) {
    return this.enqueue(slot, async () => {
      if (!slot.required && !slot.users) await this.action("stop", service);
    });
  }

  async reconcile(required: ReadonlySet<string>) {
    for (const service of required) this.slot(service);
    const tasks: Promise<unknown>[] = [];
    for (const [service, slot] of this.slots) {
      const next = required.has(service);
      if (next === slot.required) continue;
      slot.required = next;
      slot.paused = false;
      tasks.push(
        next
          ? this.enqueue(slot, async () => {
              if (slot.required && !slot.paused) await this.start(service);
            })
          : this.idle(service, slot),
      );
    }
    // Failed warmup is reported by native status; the next request retries startup.
    await Promise.allSettled(tasks);
  }

  async acquire(
    service: string,
    signal?: AbortSignal,
    executablePath?: string,
  ): Promise<ServiceLease> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const slot = this.slot(service);
    slot.users++;
    slot.paused = false;
    const generation = slot.generation;
    let ready = false;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      slot.users--;
      if (ready) slot.readyUsers--;
      await this.idle(service, slot);
    };
    const started = this.enqueue(slot, async () => {
      if (signal?.aborted || generation !== slot.generation)
        throw new DOMException("Aborted", "AbortError");
      const connection = await this.start(service, executablePath);
      if (generation !== slot.generation)
        throw new DOMException("Aborted", "AbortError");
      return connection;
    });
    let abort: (() => void) | undefined;
    try {
      const connection = signal
        ? await Promise.race([
            started,
            new Promise<never>((_, reject) => {
              abort = () => reject(new DOMException("Aborted", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ])
        : await started;
      if (signal?.aborted || generation !== slot.generation)
        throw new DOMException("Aborted", "AbortError");
      ready = true;
      slot.readyUsers++;
      return { connection, release };
    } catch (error) {
      // Queue cleanup behind startup without delaying cancellation until CLI readiness.
      void release().catch(() => {});
      throw error;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  async stop(service: string) {
    const slot = this.slot(service);
    if (slot.users) throw new Error("Local service has active requests");
    slot.paused = true;
    return this.enqueue(slot, async () => {
      if (slot.users) throw new Error("Local service has active requests");
      return this.action("stop", service);
    });
  }

  async cancelStart(service: string) {
    const slot = this.slot(service);
    if (slot.readyUsers) throw new Error("Local service has active requests");
    slot.paused = true;
    slot.generation++;
    // Do not enqueue behind the startup that we need to interrupt.
    return this.action("stop", service);
  }
}
