const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: any): value is Record<string, any> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copy(value: any): any {
  if (Array.isArray(value)) return value.map(copy);
  if (isPlainObject(value)) return merge({}, value);
  return value;
}

/** Merge own, safe keys. Objects recurse; arrays and scalar values replace. */
export function merge(target: any, source: any) {
  if (!isPlainObject(source)) return target;
  for (const key of Object.keys(source)) {
    if (unsafeKeys.has(key)) continue;
    const value = source[key];
    if (isPlainObject(value)) {
      const current =
        Object.prototype.hasOwnProperty.call(target, key) &&
        isPlainObject(target[key])
          ? target[key]
          : {};
      target[key] = merge(current, value);
    } else {
      target[key] = copy(value);
    }
  }
  return target;
}
