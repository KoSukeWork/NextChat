import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (bytes) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const describe = (value) =>
  value === undefined
    ? { present: false }
    : { present: true, ...digest(Buffer.from(JSON.stringify(value))) };

export function decodeRequest(capture) {
  if (typeof capture?.wireBase64 !== "string")
    throw new Error(
      "Full raw request required; redacted/subset fixtures cannot pass parity",
    );
  const wire = Buffer.from(capture.wireBase64, "base64");
  const end = wire.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("Incomplete HTTP header");
  const [line, ...lines] = wire
    .subarray(0, end)
    .toString("latin1")
    .split("\r\n");
  if (!/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(line))
    throw new Error("Invalid request line");
  const headers = lines.map((header) => {
    const colon = header.indexOf(":");
    if (colon < 1) throw new Error("Invalid request header");
    return [header.slice(0, colon), header.slice(colon + 1).trim()];
  });
  const body = wire.subarray(end + 4);
  const lengths = headers.filter(
    ([key]) => key.toLowerCase() === "content-length",
  );
  if (headers.some(([key]) => key.toLowerCase() === "transfer-encoding"))
    throw new Error("Chunked captures are not supported by this HTTP/1 probe");
  if (
    lengths.length !== 1 ||
    !/^\d+$/.test(lengths[0][1]) ||
    Number(lengths[0][1]) !== body.length
  )
    throw new Error("Incomplete or ambiguous request body");
  return { wire, line, headers, body, head: wire.subarray(0, end + 4) };
}

// No ignore list or normalization: every byte contributes to equality. Parsed
// JSON is diagnostic only; object ordering/whitespace still fail the byte check.
export function compareRequests(referenceCapture, candidateCapture) {
  const reference = decodeRequest(referenceCapture);
  const candidate = decodeRequest(candidateCapture);
  const changes = [];
  let count = 0;
  const change = (path, expected, actual) => {
    count++;
    if (changes.length < 200)
      changes.push({
        path,
        reference: describe(expected),
        candidate: describe(actual),
      });
  };
  const walk = (expected, actual, path) => {
    if (Object.is(expected, actual)) return;
    if (
      expected &&
      actual &&
      typeof expected === "object" &&
      typeof actual === "object" &&
      Array.isArray(expected) === Array.isArray(actual)
    ) {
      for (const key of new Set([
        ...Object.keys(expected),
        ...Object.keys(actual),
      ]))
        walk(
          expected[key],
          actual[key],
          `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        );
    } else change(path, expected, actual);
  };
  if (reference.line !== candidate.line)
    change("/requestLine", reference.line, candidate.line);
  walk(reference.headers, candidate.headers, "/headers");
  try {
    walk(
      JSON.parse(reference.body.toString("utf8")),
      JSON.parse(candidate.body.toString("utf8")),
      "/body",
    );
  } catch {
    if (!reference.body.equals(candidate.body))
      change(
        "/body",
        reference.body.toString("base64"),
        candidate.body.toString("base64"),
      );
  }
  return {
    scope:
      "one captured HTTP/1 request; TLS and general request generation are not assessed",
    equal: reference.wire.equals(candidate.wire),
    requestLineEqual: reference.line === candidate.line,
    headerBytesEqual: reference.head.equals(candidate.head),
    bodyBytesEqual: reference.body.equals(candidate.body),
    reference: digest(reference.wire),
    candidate: digest(candidate.wire),
    changes,
    omittedChanges: count - changes.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [
    referencePath,
    candidatePath,
    referenceIndex = "0",
    candidateIndex = "0",
  ] = process.argv.slice(2);
  if (!referencePath || !candidatePath)
    throw new Error(
      "Usage: node scripts/request-parity.mjs reference.json candidate.json [referenceIndex] [candidateIndex]",
    );
  const [reference, candidate] = await Promise.all(
    [referencePath, candidatePath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  const report = compareRequests(
    reference.captures[Number(referenceIndex)],
    candidate.captures[Number(candidateIndex)],
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.equal) process.exitCode = 1;
}
