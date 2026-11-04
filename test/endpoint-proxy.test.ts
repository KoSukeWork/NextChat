/** @jest-environment node */
import { jest } from "@jest/globals";
import { handleEndpointRequest } from "../app/utils/endpoint-proxy";
import { POST } from "../app/api/endpoint/route";

test("relays method, headers, body and streaming chunks", async () => {
  const encoder = new TextEncoder();
  let sendSecond!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first"));
      sendSecond = () => {
        controller.enqueue(encoder.encode("second"));
        controller.close();
      };
    },
  });
  const upstream = jest.fn(async (url: any, options: any) => {
    expect(url).toBe("http://127.0.0.1:3456/custom");
    expect(options.method).toBe("POST");
    expect(options.headers.get("authorization")).toBe("Bearer test-key");
    expect(options.headers.get("content-type")).toBe("application/json");
    expect(await new Response(options.body).text()).toBe('{"test":true}');
    return new Response(body, {
      status: 201,
      headers: { "content-type": "text/event-stream", "x-test": "value" },
    });
  });
  const headers = encodeURIComponent(
    JSON.stringify({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    }),
  );
  const request = new Request(
    `http://app.test/api/endpoint?url=${encodeURIComponent(
      "http://127.0.0.1:3456/custom",
    )}`,
    {
      method: "POST",
      headers: { "x-endpoint-headers": headers },
      body: '{"test":true}',
    },
  );
  const response = await handleEndpointRequest(
    request,
    upstream as typeof fetch,
  );
  expect(response.status).toBe(201);
  expect(response.headers.get("x-test")).toBe("value");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  sendSecond();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
  expect((await reader.read()).done).toBe(true);
});

test("passes upstream errors and rejects malformed endpoint requests", async () => {
  const upstream = jest.fn(
    async () => new Response("unauthorized", { status: 401 }),
  );
  const response = await handleEndpointRequest(
    new Request("http://app.test/api/endpoint?url=https%3A%2F%2Fexample.test"),
    upstream as typeof fetch,
  );
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("unauthorized");
  const invalid = await handleEndpointRequest(
    new Request(
      "http://app.test/api/endpoint?url=file%3A%2F%2F%2Fetc%2Fpasswd",
    ),
    upstream as typeof fetch,
  );
  expect(invalid.status).toBe(400);
});

test("the web relay requires the deployment access code even with an API key", async () => {
  const original = process.env.CODE;
  process.env.CODE = "correct-code";
  const upstream = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer upstream-key",
      );
      return new Response("ok", { status: 200 });
    });
  try {
    const target =
      "http://app.test/api/endpoint?url=https%3A%2F%2Fexample.test";
    const encoded = encodeURIComponent(
      JSON.stringify({ authorization: "Bearer upstream-key" }),
    );
    for (const token of ["", "Bearer nk-wrong", "Bearer upstream-key"]) {
      const response = await POST(
        new Request(target, {
          method: "POST",
          headers: { authorization: token, "x-endpoint-headers": encoded },
          body: "{}",
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("x-nextchat-auth-error")).toBe("1");
    }
    expect(upstream).not.toHaveBeenCalled();
    const response = await POST(
      new Request(target, {
        method: "POST",
        headers: {
          authorization: "Bearer nk-correct-code",
          "x-endpoint-headers": encoded,
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  } finally {
    upstream.mockRestore();
    if (original === undefined) delete process.env.CODE;
    else process.env.CODE = original;
  }
});
