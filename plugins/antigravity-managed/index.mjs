function bridge(context) {
  const { bridgeUrl, bridgeToken, nativeCliVersion } = context.config;
  if (!bridgeToken || bridgeToken.length < 16)
    throw new Error(
      "桥接令牌至少需要 16 个字符 / Bridge token must contain at least 16 characters",
    );
  if (!/^\d+\.\d+\.\d+$/.test(nativeCliVersion || ""))
    throw new Error("请填写准确的 agy 版本 / Enter the exact agy version");
  const url = new URL(bridgeUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("桥接地址无效 / Invalid bridge URL");
  return {
    base: url.toString().replace(/\/+$/, ""),
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    version: nativeCliVersion,
  };
}

export function prepareChat(chat, context) {
  if (context.config.connection === "builtin") {
    if (!context.hostDrivers?.includes("antigravity"))
      throw new Error(
        "内置 agy 仅支持桌面版 / Built-in agy is available on desktop",
      );
    return { hostDriver: "antigravity" };
  }
  if (context.config.connection !== "external")
    throw new Error("请选择连接方式 / Select a connection");
  const { base, headers, version } = bridge(context);
  const effort = context.config.nativeEffort || chat.reasoningEffort;
  return {
    url: `${base}/v1/drivers/antigravity/chat`,
    headers,
    body: {
      sessionId: context.sessionId,
      model: chat.model,
      messages: chat.messages,
      enableTools: chat.enableTools,
      cliVersion: version,
      ...(effort ? { reasoningEffort: effort } : {}),
    },
  };
}

export function prepareModels(context) {
  if (context.config.connection === "builtin") {
    if (!context.hostDrivers?.includes("antigravity"))
      throw new Error(
        "内置 agy 仅支持桌面版 / Built-in agy is available on desktop",
      );
    return { hostDriver: "antigravity" };
  }
  const { base, headers, version } = bridge(context);
  return {
    url: `${base}/v1/drivers/antigravity/models?version=${encodeURIComponent(
      version,
    )}`,
    headers,
  };
}

export function prepareRequest() {
  throw new Error(
    "Antigravity 请求使用 ACP 驱动 / Antigravity requests use the ACP driver",
  );
}
