import { merge } from "../app/utils/merge";

describe("merge", () => {
  test("arrays replace wholesale, including empty arrays and nested objects", () => {
    const source = { models: [{ name: "X" }], nested: { values: [] } };
    const target = {
      models: [{ name: "A", obsolete: true }, { name: "B" }],
      nested: { values: [1, 2] },
    };
    merge(target, source);
    expect(target).toEqual({ models: [{ name: "X" }], nested: { values: [] } });
    expect(target.models).not.toBe(source.models);
    expect(target.models[0]).not.toBe(source.models[0]);
  });

  test("blocks dangerous keys at every depth, including array elements", () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"prototype":{"polluted":true}},"list":[{"__proto__":{"polluted":true},"safe":1}],"hasOwnProperty":"overridden"}',
    );
    const target: any = {};
    merge(target, source);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target).toEqual({
      nested: {},
      list: [{ safe: 1 }],
      hasOwnProperty: "overridden",
    });
    merge(target, { ok: true });
    expect(target.ok).toBe(true);
  });

  test("handles null-prototype sources and object/scalar type changes", () => {
    const source = Object.assign(Object.create(null), {
      safe: { a: 1 },
      array: [],
      nil: null,
    });
    const target = { safe: 3, array: { stale: 1 }, nil: { stale: 1 } };
    merge(target, source);
    expect(target).toEqual({ safe: { a: 1 }, array: [], nil: null });
  });
  test("adds flat properties from source into target", () => {
    const target: any = { a: 1 };
    merge(target, { b: 2 });
    expect(target).toEqual({ a: 1, b: 2 });
  });

  test("overwrites primitive values", () => {
    const target: any = { a: 1, b: "old" };
    merge(target, { b: "new" });
    expect(target).toEqual({ a: 1, b: "new" });
  });

  test("deep-merges nested objects instead of replacing them", () => {
    const target: any = { a: { x: 1 } };
    merge(target, { a: { y: 2 } });
    expect(target).toEqual({ a: { x: 1, y: 2 } });
  });

  test("creates missing nested targets", () => {
    const target: any = {};
    merge(target, { a: { b: { c: 3 } } });
    expect(target).toEqual({ a: { b: { c: 3 } } });
  });
});
