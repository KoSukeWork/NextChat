// Local-only manual acceptance server: node test/fixtures/thinking-sse.cjs
// POST /finish ends all held streams; no requests leave this machine.
const http = require("node:http");
const pending = new Set();
const requests = [];
function chunk(response, delta) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
}
http
  .createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }
    if (request.url === "/finish") {
      for (const stream of pending) {
        chunk(stream, {
          content:
            "## 验证结果\n\n正文正常显示，思考过程默认收起。\n\n> 这是正文中的普通引用，应当保留。\n\n- 支持展开与收起\n- 历史仅发送正文",
        });
        stream.end("data: [DONE]\n\n");
      }
      pending.clear();
      response.end("finished");
      return;
    }
    if (request.url === "/requests") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(requests));
      return;
    }
    if (request.url.endsWith("/models")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "mock-thinking", object: "model", owned_by: "local" }],
        }),
      );
      return;
    }
    let body = "";
    request.on("data", (data) => {
      body += data;
    });
    request.on("end", () => {
      if (!request.url.endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const payload = JSON.parse(body);
      requests.push(payload);
      if (!payload.stream) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "思考折叠验证" } }],
          }),
        );
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      chunk(response, {
        reasoning_content:
          "先确认任务的三个部分：\n\n1. **默认收起**思考过程。\n2. 展开时持续显示实时 Markdown。\n3. 正文中的引用与思考内容分开处理。\n\n正在核对结果……",
      });
      pending.add(response);
      response.on("close", () => pending.delete(response));
    });
  })
  .listen(3043, "127.0.0.1", () =>
    console.log("Thinking mock SSE: http://127.0.0.1:3043"),
  );
