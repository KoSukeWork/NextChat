/** Relay endpoint requests for the web client, retaining streaming responses. */
export async function handleEndpointRequest(
  request: Request,
  requestFetch: typeof fetch = fetch,
): Promise<Response> {
  let target: URL;
  let headers: Headers;
  try {
    target = new URL(new URL(request.url).searchParams.get("url") ?? "");
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw new Error("Invalid protocol");
    const encoded = request.headers.get("x-endpoint-headers") ?? "%7B%7D";
    const value = JSON.parse(decodeURIComponent(encoded));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid headers");
    headers = new Headers(value);
  } catch {
    return Response.json(
      { error: "Invalid endpoint request" },
      { status: 400 },
    );
  }

  try {
    const method = request.method.toUpperCase();
    const response = await requestFetch(target.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? null : request.body,
      redirect: "manual",
      signal: request.signal,
      // Node's fetch requires this for a streaming request body.
      ...({ duplex: "half" } as object),
    });
    const responseHeaders = new Headers(response.headers);
    // Fetch may decode the body, so these transport headers no longer apply.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Endpoint request failed",
      },
      { status: 502 },
    );
  }
}
