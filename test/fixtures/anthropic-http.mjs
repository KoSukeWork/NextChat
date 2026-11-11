import http from "node:http";

export async function mockAnthropic({ toolFile, stall = false } = {}) {
  const captures = [];
  let receive, disconnect;
  const received = new Promise((resolve) => {
    receive = resolve;
  });
  const disconnected = new Promise((resolve) => {
    disconnect = resolve;
  });
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    captures.push({ path: req.url, headers: req.headers, body });
    receive();
    res.on("close", disconnect);
    if (stall) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const message = {
      id: `msg_${captures.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    const text = `Reply ${captures.length}`;
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ...message,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const useTool = toolFile && captures.length === 1;
    for (const event of [
      { type: "message_start", message },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Checking the local fixture.",
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "signature_delta",
          signature: "local-fixture-signature",
        },
      },
      { type: "content_block_stop", index: 0 },
      ...(useTool
        ? [
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "tool_fixture_read",
                name: "Read",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ file_path: toolFile }),
              },
            },
          ]
        : [
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text },
            },
          ]),
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: {
          stop_reason: useTool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    captures,
    received,
    disconnected,
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
