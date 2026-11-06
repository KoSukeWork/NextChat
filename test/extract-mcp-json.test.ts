import { findMcpCall } from "../app/mcp/utils";

describe("findMcpCall", () => {
  test("extracts the client id and raw mcp payload", () => {
    const content = '```json:mcp:client-1\n{"tool":"x"}\n```';
    const match = findMcpCall(content);
    expect(match?.clientId).toBe("client-1");
    expect(JSON.parse(match!.raw)).toEqual({ tool: "x" });
  });

  test("returns null when there is no mcp block", () => {
    expect(findMcpCall("no mcp here")).toBeNull();
  });
});
