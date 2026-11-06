export {};

await import("../app/locales");
const { default: cn } = await import("../app/locales/cn");
const { default: en } = await import("../app/locales/en");
const { localizedMcpError } = await import("../app/mcp/error-message");

test("MCP error labels have locale-appropriate punctuation", () => {
  expect(`${cn.Mcp.Error}${cn.Mcp.ErrorSeparator}远程错误`).toBe(
    "错误：远程错误",
  );
  expect(`${en.Mcp.Error}${en.Mcp.ErrorSeparator}Remote error`).toBe(
    "Error: Remote error",
  );
});

test.each([cn, en])(
  "MCP diagnostics use the selected language without exposing unknown text",
  (locale) => {
    const messages = locale.Mcp.Errors;
    expect(
      localizedMcpError(
        "Remote MCP connection failed (HTTP 401)",
        messages.General,
        messages,
      ),
    ).toBe(messages.Http("401"));
    expect(
      localizedMcpError(
        "Remote MCP network request timed out",
        messages.General,
        messages,
      ),
    ).toBe(messages.Timeout);
    expect(
      localizedMcpError(
        "Remote MCP network connection was refused",
        messages.General,
        messages,
      ),
    ).toBe(messages.Refused);
    expect(
      localizedMcpError(
        "Remote MCP DNS lookup failed",
        messages.General,
        messages,
      ),
    ).toBe(messages.Dns);
    expect(
      localizedMcpError(
        "Remote MCP TLS connection failed",
        messages.General,
        messages,
      ),
    ).toBe(messages.Tls);
    expect(
      localizedMcpError(
        "MCP configuration was not approved. No changes were saved.",
        messages.General,
        messages,
      ),
    ).toBe(messages.Denied);
    expect(localizedMcpError("secret-key", messages.General, messages)).toBe(
      messages.General,
    );
  },
);
