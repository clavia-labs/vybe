import type { JsonObject } from "./types.js";

/** Internal marker carried by a ref proxy. */
export const REF = Symbol("vybe.ref");
export const STATE = Symbol("vybe.state");

export interface RefMetadata<T = unknown> {
  [REF]: true;
  state: object;
  path: string;
  value: T;
}

export type Ref<T, Path extends string = string> = RefMetadata<T> &
  (T extends readonly (infer U)[]
    ? { readonly [index: number]: Ref<U, `${Path}.${number}`> }
    : T extends object
      ? {
          readonly [K in keyof T]-?: Ref<T[K], `${Path}.${Extract<K, string>}`>;
        }
      : unknown);

export type Refs<T extends JsonObject> = {
  readonly [K in keyof T]-?: Ref<T[K], Extract<K, string>>;
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Return metadata from a ref without touching user-defined properties. */
export function refMetadata(value: unknown): RefMetadata | undefined {
  if (!isObject(value)) return undefined;
  try {
    const metadata = (value as Record<PropertyKey, unknown>)[REF];
    return metadata && typeof metadata === "object"
      ? (metadata as RefMetadata)
      : undefined;
  } catch {
    return undefined;
  }
}

export function isRef(value: unknown): value is RefMetadata {
  return Boolean(refMetadata(value));
}

/** Build a typed path proxy. Proxies keep refs cheap and preserve array indexing. */
export function createRef<T>(state: object, value: T, path: string): Ref<T> {
  const target: Record<PropertyKey, unknown> = {};
  const metadata: RefMetadata<T> = { [REF]: true, state, path, value };
  Object.defineProperty(target, REF, { value: metadata, enumerable: false });

  return new Proxy(target, {
    get(_target, property) {
      if (property === REF) return metadata;
      // Thenable detection by Promise/await must never turn refs into promises.
      if (property === "then") return undefined;
      if (property === "toJSON") return () => value;
      if (property === Symbol.toStringTag) return "VybeRef";
      if (typeof property === "symbol") return undefined;
      if (isObject(value)) {
        const child = (value as Record<string, unknown>)[property];
        if (child !== undefined || property in (value as object)) {
          return createRef(state, child, `${path}.${property}`);
        }
      }
      return undefined;
    },
    set() {
      throw new TypeError("Vybe refs are immutable");
    },
    has(_target, property) {
      return property === REF || (isObject(value) && property in value);
    },
  }) as Ref<T>;
}
