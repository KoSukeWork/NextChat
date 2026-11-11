/** One disposable module worker per hook: no UI/store imports or shared globals. */
export function callPlugin(
  source: string,
  hook: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const entry = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
  const bootstrap = URL.createObjectURL(
    new Blob(
      [
        `import * as plugin from ${JSON.stringify(entry)};
     self.onmessage = async ({data}) => {
       try {
         const value = typeof plugin[data.hook] === 'function'
           ? await plugin[data.hook](...data.args)
           : data.hook === 'prepareRequest' ? data.args[0] : null;
         self.postMessage({ok:true,value});
       } catch(error) { self.postMessage({ok:false,error:String(error?.message || error)}); }
     };`,
      ],
      { type: "text/javascript" },
    ),
  );
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const close = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
      URL.revokeObjectURL(entry);
      URL.revokeObjectURL(bootstrap);
    };
    const fail = (error: Error) => {
      close();
      reject(error);
    };
    const abort = () => fail(new DOMException("Aborted", "AbortError"));
    try {
      worker = new Worker(bootstrap, {
        type: "module",
        name: "nextchat-request-plugin",
      });
      timer = setTimeout(
        () => fail(new Error("Request plugin timed out")),
        10000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => {
        close();
        data.ok
          ? resolve(data.value)
          : reject(new Error(`Request plugin: ${data.error}`));
      };
      worker.onerror = () =>
        fail(
          new Error(
            "Cannot load request plugin. Check its ESM source and worker policy.",
          ),
        );
      worker.postMessage({ hook, args });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
