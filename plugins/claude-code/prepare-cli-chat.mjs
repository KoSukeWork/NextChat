// Portable frontend hook for the existing --print bridge. Process management
// stays in driver.mjs; neither the host nor the HTTP adapter launches the CLI.
export function prepareCliChat(chat, context) {
  const { config, endpoint, sessionId, requestId } = context;
  if (!config.bridgeToken || config.bridgeToken.length < 16)
    throw new Error(
      "请配置至少16字符的桥接服务令牌 / Configure a bridge token of at least 16 characters",
    );
  if (!/^\d+\.\d+\.\d+$/.test(config.nativeCliVersion || ""))
    throw new Error("Specify the exact installed Claude Code version");
  if (!["api-key", "bearer"].includes(config.authType))
    throw new Error("Invalid gateway authentication type");
  const bridge = new URL(config.bridgeUrl);
  if (
    !["http:", "https:"].includes(bridge.protocol) ||
    bridge.username ||
    bridge.password ||
    bridge.search ||
    bridge.hash
  )
    throw new Error("Invalid CLI bridge URL");
  return {
    url: `${bridge.toString().replace(/\/+$/, "")}/v1/drivers/claude-code/chat`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.bridgeToken}`,
    },
    body: {
      ...chat,
      endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
      sessionId,
      requestId,
      cliVersion: config.nativeCliVersion,
      authType: config.authType,
      betas: (config.nativeBeta || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
  };
}
