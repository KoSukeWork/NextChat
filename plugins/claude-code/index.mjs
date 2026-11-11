// SDK v1 plugin. The packer bundles this dependency into the portable ESM.
/*!
 * Bundled dependency: @noble/hashes — The MIT License (MIT)
 * Copyright (c) 2022 Paul Miller (https://paulmillr.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const capturedVersion = "2.1.322";
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const billingPrefix = "x-anthropic-billing-header:";
const contextBeta = "context-management-2025-06-27";
const displayBeta = "thinking-display-updates-2026-08-18";
const hash = (text) => bytesToHex(sha256(text));
const clone = (value) => JSON.parse(JSON.stringify(value));
const ephemeral = () => ({ type: "ephemeral" });

function object(raw, label) {
  const value = JSON.parse(raw || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  if (
    Object.keys(value).some((key) =>
      ["__proto__", "prototype", "constructor"].includes(key),
    )
  )
    throw new Error(`Invalid ${label} key`);
  return value;
}

function firstUserText(messages) {
  const content = messages.find((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  // NextChat sends the actual user content, without CLI-injected reminders.
  return content?.find((block) => block.type === "text")?.text || "";
}

function billing(text, version) {
  // Community protocol research, verified against our interactive capture.
  // These are JS UTF-16 positions, NOT Unicode code-point positions.
  const sample = [4, 7, 20].map((position) => text[position] || "0").join("");
  const suffix = hash(`59cf53e54c78${sample}${version}`).slice(0, 3);
  // The API-key/custom-base-URL capture has no cch field. Do not invent one.
  return `${billingPrefix} cc_version=${version}.${suffix}; cc_entrypoint=cli;`;
}

function normalizeSystem(system, extra, billingText, cache) {
  const blocks =
    typeof system === "string"
      ? system
        ? [{ type: "text", text: system }]
        : []
      : system || [];
  if (
    !Array.isArray(blocks) ||
    blocks.some((b) => b.type !== "text" || typeof b.text !== "string")
  )
    throw new Error("Claude Code system blocks must contain text");
  const wrapped =
    blocks[0]?.text.startsWith(billingPrefix) && blocks[1]?.text === identity;
  const original = blocks.filter(
    (b) => !b.text.startsWith(billingPrefix) && b.text !== identity,
  );
  // Preserve caller breakpoints verbatim when automatic caching is disabled.
  if (!cache)
    return [
      { type: "text", text: billingText },
      blocks.find((b) => b.text === identity) || {
        type: "text",
        text: identity,
      },
      ...(!wrapped && extra ? [{ type: "text", text: extra }] : []),
      ...original,
    ];
  const text = original.map((b) => b.text).join("\n\n");
  const instruction =
    [wrapped ? "" : extra, text].filter(Boolean).join("\n\n") ||
    "Assist the user with their requests. Use only the tools provided in this conversation.";
  return [
    { type: "text", text: billingText },
    {
      type: "text",
      text: identity,
      ...(cache ? { cache_control: ephemeral() } : {}),
    },
    {
      type: "text",
      text: instruction,
      ...(cache ? { cache_control: ephemeral() } : {}),
    },
  ];
}

function normalizeMessages(messages, cache) {
  if (!Array.isArray(messages)) throw new Error("Messages must be an array");
  for (const message of messages) {
    if (typeof message.content === "string")
      message.content = [{ type: "text", text: message.content }];
    if (!Array.isArray(message.content))
      throw new Error("Invalid message content");
    if (cache) {
      for (const block of message.content) delete block.cache_control;
    }
  }
  if (!cache) return;
  // A thinking block must never receive a cache breakpoint. Do not alter its
  // signature or any tool IDs/names/results; NextChat owns tool execution.
  const last = messages.at(-1)?.content;
  const block = last?.at(-1);
  if (
    block &&
    ["text", "image", "document", "tool_use", "tool_result"].includes(
      block.type,
    )
  )
    block.cache_control = ephemeral();
}

export function prepareRequest(request, context) {
  const { config, endpoint, operation, sessionId } = context;
  const version = config.cliVersion;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Specify an exact Claude Code version (e.g. 2.1.322)");
  if (config.profile !== "custom" && version !== capturedVersion)
    throw new Error(
      `Only ${capturedVersion} has a captured profile; select Custom version to test ${version}`,
    );
  if (operation === "models" && config.modelList !== "standard")
    throw new Error(
      "请手动添加模型；仅在网关支持模型列表时启用该选项。 / Add models manually or enable gateway model listing.",
    );

  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  Object.assign(headers, {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": config.userAgent || `claude-cli/${version} (external, cli)`,
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-stainless-lang": "js",
    "x-stainless-package-version": config.sdkVersion,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": config.runtimeVersion,
    "x-stainless-arch": config.arch,
    "x-stainless-os": config.platform,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "x-claude-code-session-id": sessionId,
  });
  delete headers.authorization;
  delete headers["x-api-key"];
  delete headers["anthropic-beta"];
  if (config.beta) headers["anthropic-beta"] = config.beta;
  if (config.authType === "bearer")
    headers.authorization = `Bearer ${endpoint.apiKey}`;
  else if (config.authType === "api-key")
    headers["x-api-key"] = endpoint.apiKey;
  else throw new Error("Invalid authentication type");
  for (const [name, value] of Object.entries(
    object(config.headerOverrides, "headers"),
  )) {
    const key = name.toLowerCase();
    if (
      ["host", "content-length", "connection", "transfer-encoding"].includes(
        key,
      )
    )
      throw new Error(`Transport header cannot be overridden: ${name}`);
    if (value === null) delete headers[key];
    else if (typeof value === "string") headers[key] = value;
    else throw new Error("Header values must be strings or null (remove)");
  }
  if (operation === "models") return { ...request, headers };

  const body = clone(request.body || {});
  if (config.maxTokens) {
    const max = Number(config.maxTokens);
    if (!Number.isSafeInteger(max) || max < 1)
      throw new Error("Max tokens must be a positive integer");
    body.max_tokens = max;
  }
  if (config.thinking === "adaptive") body.thinking = { type: "adaptive" };
  else if (config.thinking === "disabled") body.thinking = { type: "disabled" };
  if (config.effort)
    body.output_config = { ...body.output_config, effort: config.effort };
  Object.assign(body, object(config.bodyOverrides, "body"));
  const betas = (headers["anthropic-beta"] || "")
    .split(",")
    .map((b) => b.trim());
  const thinking = body.thinking && body.thinking.type !== "disabled";
  if (thinking) {
    // Sampling controls conflict with adaptive thinking on current models.
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
    if (config.thinking === "adaptive" && betas.includes(displayBeta))
      body.thinking.display ??= "updates";
  }
  if (thinking && betas.includes(contextBeta))
    body.context_management ??= {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    };
  else if (!betas.includes(contextBeta) || !thinking)
    delete body.context_management;

  const device =
    config.deviceId || hash(`nextchat.claude-code.device:${endpoint.id}`);
  if (!/^[a-f\d]{64}$/i.test(device))
    throw new Error("Device ID must be 64 hexadecimal characters");
  const wireSession = headers["x-claude-code-session-id"];
  if (!wireSession) throw new Error("A Claude Code session ID is required");
  body.metadata = {
    ...body.metadata,
    user_id: JSON.stringify({
      device_id: device,
      account_uuid: config.accountUuid || "",
      session_id: wireSession,
    }),
  };
  const cache = config.cache !== "preserve";
  normalizeMessages(body.messages, cache);
  if (cache) {
    delete body.cache_control;
    for (const tool of body.tools || []) delete tool.cache_control;
  }
  body.system = normalizeSystem(
    body.system,
    config.systemPrompt,
    billing(firstUserText(body.messages), version),
    cache,
  );
  const url = new URL(request.url);
  url.searchParams.set("beta", "true");
  return { url: url.toString(), headers, body };
}
