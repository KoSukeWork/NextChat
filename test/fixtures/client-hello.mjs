/** Inspect stable ClientHello fields; crypto entropy is deliberately excluded. */
export function inspectClientHello(record) {
  if (record.length < 9 || record[0] !== 22 || record[5] !== 1)
    throw new Error("Expected a complete TLS ClientHello record");
  if (record.length !== 5 + record.readUInt16BE(3))
    throw new Error("Incomplete TLS record");
  const grease = (n) => (n & 0x0f0f) === 0x0a0a && n >> 8 === (n & 255);
  const id = (n) => (grease(n) ? "GREASE" : n);
  const vector = (b) =>
    Array.from({ length: b.length / 2 }, (_, i) => id(b.readUInt16BE(i * 2)));
  const b = record.subarray(5);
  let p = 4;
  const version = b.readUInt16BE(p);
  p += 34;
  const sessionIdLength = b[p++];
  p += sessionIdLength;
  const cipherLength = b.readUInt16BE(p);
  p += 2;
  const ciphers = vector(b.subarray(p, p + cipherLength));
  p += cipherLength;
  const compressionLength = b[p++];
  const compression = [...b.subarray(p, p + compressionLength)];
  p += compressionLength;
  const end = p + 2 + b.readUInt16BE(p);
  p += 2;
  if (end > b.length) throw new Error("Incomplete extensions");
  const extensions = [];
  while (p < end) {
    const type = b.readUInt16BE(p),
      length = b.readUInt16BE(p + 2);
    p += 4;
    if (p + length > end) throw new Error("Invalid extension length");
    const data = b.subarray(p, p + length);
    p += length;
    let value;
    if (type === 51) {
      value = [];
      for (let k = 2; k < data.length; ) {
        const group = data.readUInt16BE(k),
          keyLength = data.readUInt16BE(k + 2);
        value.push({ group: id(group), keyLength });
        k += 4 + keyLength;
      }
    } else if (type === 10 || type === 13) value = vector(data.subarray(2));
    else if (type === 43) value = vector(data.subarray(1));
    else if (grease(type)) value = "GREASE";
    else value = data.toString("hex");
    extensions.push({ type: id(type), length, value });
  }
  return {
    recordVersion: record.readUInt16BE(1),
    recordLength: record.length,
    version,
    sessionIdLength,
    ciphers,
    compression,
    extensions,
  };
}
