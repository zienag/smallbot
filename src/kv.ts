/**
 * A KV read may be answered from the edge cache of an earlier read of the same
 * key, up to a minute old, and so miss a write this invocation has just made.
 * The returned namespace answers a key it has written from that write.
 */
export function readingOwnWrites(kv: KVNamespace): KVNamespace {
  const written = new Map<string, string | null>();
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "get") {
        return (key: string, ...rest: unknown[]) =>
          rest.length === 0 && written.has(key)
            ? Promise.resolve(written.get(key))
            : (target.get as (...args: unknown[]) => unknown).call(target, key, ...rest);
      }
      if (prop === "put") {
        return async (key: string, value: unknown, ...rest: unknown[]) => {
          await (target.put as (...args: unknown[]) => Promise<void>).call(target, key, value, ...rest);
          if (typeof value === "string") written.set(key, value);
          else written.delete(key);
        };
      }
      if (prop === "delete") {
        return async (key: string) => {
          await target.delete(key);
          written.set(key, null);
        };
      }
      const member = Reflect.get(target, prop);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
