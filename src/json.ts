/**
 * Internal strict-JSON validation shared by `inventory.ts` and `state.ts`.
 * It is not re-exported from `src/index.ts`, so it stays out of the public API.
 *
 * Both callers need the same walk: only plain objects, arrays, strings, finite
 * numbers, booleans, and null; no circular references; bounded depth; data
 * properties only. They deliberately differ on what counts as a lossy shape
 * and on whether the clone is frozen, so that lives in {@link JsonClonePolicy}.
 */

/** Maximum nesting depth accepted by {@link createJsonCloner}. */
export const MAX_JSON_DEPTH = 64;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export interface JsonClonePolicy {
  /** Builds the error thrown for invalid input. The message has no prefix. */
  fail(message: string): Error;
  /** Deep-freeze every cloned object and array. */
  freeze?: boolean;
  /**
   * Reject the shapes `JSON.stringify` silently drops or evaluates: symbol
   * keys, non-index array keys, accessor array entries, and non-enumerable own
   * properties. Off, they are read the way `JSON.stringify` reads them.
   */
  strict?: boolean;
}

export type JsonCloner = (value: unknown, path: string) => unknown;

interface ResolvedPolicy {
  readonly fail: (message: string) => Error;
  readonly freeze: boolean;
  readonly strict: boolean;
}

/**
 * Creates a validating deep-cloner bound to `policy`. The returned function
 * shares no objects or arrays with its input and reports the failing `path`.
 */
export function createJsonCloner(policy: JsonClonePolicy): JsonCloner {
  const resolved: ResolvedPolicy = {
    fail: policy.fail,
    freeze: policy.freeze === true,
    strict: policy.strict === true,
  };
  return (value, path) => cloneValue(value, path, resolved, new Set(), 0);
}

function isNonJsonValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  );
}

function cloneValue(
  value: unknown,
  path: string,
  policy: ResolvedPolicy,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw policy.fail(`${path} is nested too deeply`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw policy.fail(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw policy.fail(
      `${path} contains a non-JSON value (${typeof value})`,
    );
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw policy.fail(`${path} contains a circular reference`);
  }
  ancestors.add(object);

  let cloned: unknown;
  if (Array.isArray(object)) {
    if (policy.strict) {
      // JSON only sees index 0..length-1 and never a symbol or extra own key, so
      // accepting those would drop data; reading `object[index]` would also run
      // accessors. Require exactly the dense indices plus the intrinsic length.
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw policy.fail(`${path} contains symbol keys`);
      }
      if (Object.getOwnPropertyNames(object).length !== object.length + 1) {
        throw policy.fail(`${path} contains non-index array keys`);
      }
    }
    const array: unknown[] = [];
    for (let index = 0; index < object.length; index += 1) {
      let element: unknown;
      if (policy.strict) {
        const descriptor = Object.getOwnPropertyDescriptor(
          object,
          String(index),
        );
        if (descriptor === undefined) {
          throw policy.fail(`${path} contains a sparse array`);
        }
        if (!("value" in descriptor)) {
          throw policy.fail(`${path}[${index}] must be a data property`);
        }
        element = descriptor.value;
      } else {
        // Matches JSON.stringify: inherited indexes are serialized and an
        // accessor index runs once per read.
        if (!(index in object)) {
          throw policy.fail(`${path} contains a sparse array`);
        }
        element = object[index];
      }
      array.push(
        cloneValue(element, `${path}[${index}]`, policy, ancestors, depth + 1),
      );
    }
    cloned = policy.freeze ? Object.freeze(array) : array;
  } else {
    if (!isPlainObject(object)) {
      throw policy.fail(
        `${path} must contain only plain objects and arrays`,
      );
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw policy.fail(`${path} contains symbol keys`);
    }
    if (
      policy.strict &&
      Object.getOwnPropertyNames(object).length !== Object.keys(object).length
    ) {
      throw policy.fail(`${path} contains a non-enumerable property`);
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw policy.fail(`${path}.${key} must be a data property`);
      }
      const child = descriptor.value;
      if (!policy.strict && isNonJsonValue(child)) {
        throw policy.fail(`${path}.${key} contains a non-JSON value`);
      }
      Object.defineProperty(record, key, {
        value: cloneValue(
          child,
          `${path}.${key}`,
          policy,
          ancestors,
          depth + 1,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    cloned = policy.freeze ? Object.freeze(record) : record;
  }

  ancestors.delete(object);
  return cloned;
}
