import { adapter } from "../app/utils";

describe("adapter", () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
  });

  // Stub window.fetch with a plain function that records the URLs it is
  // called with and resolves to a minimal Response-like object.
  function stubFetch() {
    const calls: string[] = [];
    window.fetch = ((url: any) => {
      calls.push(String(url));
      return Promise.resolve({
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("response-body"),
      } as Response);
    }) as typeof window.fetch;
    return calls;
  }

  test("joins baseURL with url and appends params as a query string", async () => {
    const calls = stubFetch();
    await adapter({
      baseURL: "https://api.example.com",
      url: "/v1/models",
      params: { a: "1", b: "2" },
      method: "get",
    });
    expect(calls[0]).toBe(`/api/endpoint?url=${encodeURIComponent("https://api.example.com/v1/models?a=1&b=2")}`);
  });

  test("uses url alone when there is no baseURL and no params", async () => {
    const calls = stubFetch();
    await adapter({ url: "https://x.test/path" });
    expect(calls[0]).toBe(`/api/endpoint?url=${encodeURIComponent("https://x.test/path")}`);
  });

  test("normalises the response into { status, statusText, headers, data }", async () => {
    stubFetch();
    const res = await adapter({ url: "https://x.test/path" });
    expect(res).toMatchObject({
      status: 200,
      statusText: "OK",
      data: "response-body",
    });
    expect(res.headers).toBeInstanceOf(Headers);
  });

  test("runs GET plugin tools without a request body and preserves POST bodies", async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    window.fetch = (async (url: any, options: RequestInit = {}) => {
      const method = (options.method ?? "GET").toUpperCase();
      if ((method === "GET" || method === "HEAD") && options.body != null) {
        throw new TypeError(`${method} requests cannot have a body`);
      }
      calls.push({ url: String(url), options });
      return {
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => '{"ok":true}',
      } as Response;
    }) as typeof window.fetch;

    // OpenAPIClientAxios serializes an empty argument object into "{}" even
    // for a GET operation; browsers reject any body on GET and HEAD requests.
    await adapter({
      baseURL: "https://tools.example.com",
      url: "/weather",
      params: { city: "Paris" },
      method: "get",
      data: "{}",
    });
    await adapter({
      baseURL: "https://tools.example.com",
      url: "/echo",
      method: "post",
      data: '{"message":"hello"}',
    });
    await adapter({
      url: "https://tools.example.com/weather",
      method: "HEAD",
      data: "{}",
    });

    expect(calls[0].url).toBe(
      `/api/endpoint?url=${encodeURIComponent("https://tools.example.com/weather?city=Paris")}`,
    );
    expect(calls[0].options.body).toBeUndefined();
    expect(calls[1].options.body).toBe('{"message":"hello"}');
    expect(calls[2].options.body).toBeUndefined();
  });
});
