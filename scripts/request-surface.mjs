import { createHash } from "node:crypto";
import { decodeRequest } from "./request-parity.mjs";

const describe = (value) => {
  if (value === undefined) return { present: false };
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    present: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

// A deliberately narrower diagnostic than byte parity. These exceptions reflect
// the requested NextChat integration, NOT knowledge of any gateway's detector.
export function compareClientSurface(referenceCapture, candidateCapture) {
  const reference = decodeRequest(referenceCapture);
  const candidate = decodeRequest(candidateCapture);
  const expected = JSON.parse(reference.body.toString("utf8"));
  const actual = JSON.parse(candidate.body.toString("utf8"));
  const checks = [];
  const check = (name, left, right) =>
    checks.push({
      name,
      pass: JSON.stringify(left) === JSON.stringify(right),
      reference: describe(left),
      candidate: describe(right),
    });
  const validate = (name, condition) =>
    checks.push({ name, pass: !!condition });
  const headerSurface = (request) =>
    request.head
      .toString("latin1")
      .split("\r\n")
      .map((line) => {
        // decodeRequest already checked Content-Length against the actual bytes.
        // Keep the original case, whitespace and position while allowing its value
        // to change with application content. Everything else remains byte-exact.
        const colon = line.indexOf(":");
        if (
          colon > 0 &&
          line.slice(0, colon).toLowerCase() === "content-length"
        )
          return (
            line.slice(0, colon + 1) +
            line.slice(colon + 1).replace(/\d+/, "<body-bytes>")
          );
        return line;
      });
  check(
    "request-line-and-headers",
    headerSurface(reference),
    headerSurface(candidate),
  );
  const contentFields = new Set(["messages", "system", "tools", "safeguards"]);
  const protocolBody = (body) =>
    Object.fromEntries(
      Object.entries(body).filter(([key]) => !contentFields.has(key)),
    );
  check(
    "protocol-body-and-serialization-order",
    protocolBody(expected),
    protocolBody(actual),
  );
  check(
    "billing-and-client-identity",
    expected.system?.slice(0, 2),
    actual.system?.slice(0, 2),
  );
  check(
    "system-cache-structure",
    expected.system?.map((block) => block.cache_control ?? null),
    actual.system?.map((block) => block.cache_control ?? null),
  );
  check(
    "last-message-cache",
    expected.messages?.at(-1)?.content?.at(-1)?.cache_control,
    actual.messages?.at(-1)?.content?.at(-1)?.cache_control,
  );
  validate(
    "messages-present",
    Array.isArray(actual.messages) && actual.messages.length > 0,
  );
  validate(
    "system-text-blocks",
    Array.isArray(actual.system) &&
      actual.system.length >= 2 &&
      actual.system.every(
        (block) => block.type === "text" && typeof block.text === "string",
      ),
  );
  try {
    const metadata = JSON.parse(actual.metadata.user_id);
    const session = candidate.headers.find(
      ([name]) => name.toLowerCase() === "x-claude-code-session-id",
    )?.[1];
    validate(
      "session-header-matches-metadata",
      typeof session === "string" && metadata.session_id === session,
    );
    validate("device-id-shape", /^[a-f\d]{64}$/i.test(metadata.device_id));
  } catch {
    validate("metadata-identity-valid", false);
  }
  return {
    scope: "captured client surface with application-owned prompts and tools",
    checksPass: checks.every((check) => check.pass),
    checks,
    excludedFromComparison: [
      "User/assistant message contents and CLI-injected runtime reminders",
      "System instruction text after the billing and identity blocks",
      "Tool declarations and tool-related safeguards/environment state",
      "Content-Length value (validated against the actual body bytes instead)",
    ],
    notAssessed: [
      "TLS, connection reuse/resumption, retries and timing",
      "Other CLI versions, configurations, input shapes or platforms",
      "Gateway acceptance or resistance to client identification",
    ],
  };
}
