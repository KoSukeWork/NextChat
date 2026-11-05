type Request =
  | { type: "encrypt"; data: unknown; password: string }
  | { type: "open"; text: string }
  | { type: "decrypt"; password: string };

/** One worker per operation keeps expensive crypto and JSON parsing off the UI thread. */
export class BackupWorker {
  private worker = new Worker(new URL("./backup-worker.ts", import.meta.url));
  private nextId = 0;

  request<T>(request: Request): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.worker.removeEventListener("message", onMessage);
        this.worker.removeEventListener("error", onError);
        this.worker.removeEventListener("messageerror", onError);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.id !== id) return;
        cleanup();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result as T);
      };
      const onError = () => {
        cleanup();
        reject(new Error("BACKUP_WORKER_FAILED"));
      };
      this.worker.addEventListener("message", onMessage);
      this.worker.addEventListener("error", onError);
      this.worker.addEventListener("messageerror", onError);
      try {
        this.worker.postMessage({ ...request, id });
      } catch {
        cleanup();
        reject(new Error("BACKUP_WORKER_FAILED"));
      }
    });
  }

  close() {
    this.worker.terminate();
  }
}
