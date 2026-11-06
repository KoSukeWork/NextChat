import { findMcpCall } from "../app/mcp/utils";

describe("findMcpCall", () => {
  test("matches a ```json:mcp fenced block and returns the match", () => {
    const content = '```json:mcp:client-1\n{"a":1}\n```';
    const match = findMcpCall(content);
    expect(match).toBeTruthy();
    expect(match!.clientId).toBe("client-1");
  });

  test("returns null for ordinary content and plain json blocks", () => {
    expect(findMcpCall("just some text")).toBeNull();
    expect(findMcpCall("```json\n{}\n```")).toBeNull();
  });
});
