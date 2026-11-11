import test from "node:test";
import assert from "node:assert/strict";
import { compareRequests } from "../scripts/request-parity.mjs";

function capture(
  body = '{"system":"private-system-text","stream":true}',
  headers = "X-Api-Key: private-credential\r\nContent-Type: application/json",
) {
  return {
    wireBase64: Buffer.from(
      `POST /v1/messages?beta=true HTTP/1.1\r\n${headers}\r\nContent-Length: ${Buffer.byteLength(
        body,
      )}\r\n\r\n${body}`,
    ).toString("base64"),
  };
}
test("parity compares every byte and does not expose field values", () => {
  assert.equal(compareRequests(capture(), capture()).equal, true);
  const report = compareRequests(
    capture(),
    capture('{"system":"different-private-text","stream":true}'),
  );
  assert.equal(report.equal, false);
  assert.ok(report.changes.some((change) => change.path === "/body/system"));
  for (const secret of [
    "private-system-text",
    "different-private-text",
    "private-credential",
  ])
    assert.ok(!JSON.stringify(report).includes(secret));
});
test("header case/order and JSON ordering/whitespace remain observable", () => {
  const reorderedBody = compareRequests(
    capture(),
    capture('{"stream":true,"system":"private-system-text"}'),
  );
  assert.equal(reorderedBody.equal, false);
  assert.equal(reorderedBody.bodyBytesEqual, false);
  assert.equal(reorderedBody.changes.length, 0);
  for (const headers of [
    "x-api-key: private-credential\r\nContent-Type: application/json",
    "Content-Type: application/json\r\nX-Api-Key: private-credential",
    "X-Api-Key:  private-credential\r\nContent-Type: application/json",
  ])
    assert.equal(
      compareRequests(capture(), capture(undefined, headers)).headerBytesEqual,
      false,
    );
});
test("missing native fields and truncated/subset captures cannot pass", () => {
  const report = compareRequests(
    capture('{"safeguards":{"mode":"auto"},"tools":[{"name":"Read"}]}'),
    capture("{}"),
  );
  assert.equal(report.equal, false);
  assert.deepEqual(
    report.changes.map((change) => change.path),
    ["/headers/2/1", "/body/safeguards", "/body/tools"],
  );
  assert.throws(
    () => compareRequests({ body: {} }, capture()),
    /Full raw request/,
  );
  assert.throws(
    () =>
      compareRequests(
        {
          wireBase64: Buffer.from(
            "POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n{}",
          ).toString("base64"),
        },
        capture(),
      ),
    /Incomplete/,
  );
});
