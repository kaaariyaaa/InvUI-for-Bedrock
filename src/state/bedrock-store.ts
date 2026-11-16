/**
 * World dynamic-property store for persistent GUI state.
 * Versioned, fixed-width identifiers prevent collisions with legacy keys.
 * Legacy data is detected but not silently read or migrated.
 */

import type { StateStore } from "./state.js";

/**
 * Maximum dynamic property identifier length, in characters: the 1.20.10
 * update notes state "Dynamic Property identifiers are now limited to 1024
 * characters" (see the 1.20.10.23 preview changelog).
 *
 * Measured after encoding with `String#length`. The encoder only emits ASCII,
 * so this is a character count rather than UTF-16 code units or bytes.
 */
export const BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH = 1_024;

/**
 * Local guard for string values — **not** a verified engine limit. 32,767 is
 * what community documentation reports, but the real per-value ceiling (and
 * whether it counts bytes or UTF-16 code units) is unknown on hardware.
 *
 * Counted in **UTF-8 bytes**, the larger of the two plausible units, so a value
 * that passes here is never larger than 32,767 by either measure. That is
 * deliberately conservative: a value of 32,767 ASCII characters is accepted,
 * but fewer than 32,767 non-ASCII characters are (see {@link utf8ByteLength}).
 * If the engine still rejects a value that passed this guard, the exception
 * propagates unchanged.
 */
export const BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH = 32_767;

/** Minimal world surface needed to persist state. */
export interface DynamicPropertyHost {
  getDynamicProperty(
    identifier: string,
  ): boolean | number | string | { x: number; y: number; z: number } | undefined;
  setDynamicProperty(
    identifier: string,
    value?: boolean | number | string | { x: number; y: number; z: number },
  ): void;
}

export type BedrockStoreErrorCode =
  | "IDENTIFIER_TOO_LONG"
  | "VALUE_TOO_LARGE"
  | "INVALID_STORED_VALUE"
  | "LEGACY_IDENTIFIER_CONFLICT";

export class BedrockStoreError extends Error {
  readonly code: BedrockStoreErrorCode;

  constructor(code: BedrockStoreErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export interface BedrockStateStoreOptions {
  /** Override the 1024-character identifier limit, e.g. for an older/newer engine build. */
  maxIdentifierLength?: number;
  /** Override the local value guard, in UTF-8 bytes, e.g. for an older/newer engine build. */
  maxValueLength?: number;
}

/** Separate current identifiers from the legacy encoding. */
const IDENTIFIER_GENERATION_PREFIX = "%:";

/**
 * Encode non-ASCII-safe UTF-16 units using fixed-width hexadecimal escapes.
 * Legacy variable-width keys are not automatically migrated.
 */
function toIdentifier(key: string): string {
  return (
    IDENTIFIER_GENERATION_PREFIX +
    key.replace(
      /[^A-Za-z0-9_.:-]/g,
      (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
    )
  );
}

/** Legacy encoder, retained only to detect incompatible stored records. */
function toLegacyIdentifier(key: string): string {
  return key.replace(
    /[^A-Za-z0-9_.:-]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * UTF-8 byte length of `value`, without `TextEncoder` (not guaranteed to exist
 * in the Bedrock script runtime). Lone surrogates count as 3 bytes, matching
 * TextEncoder's replacement-character behaviour.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function assertKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("state store key must be a non-empty string");
  }
  return key;
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** `StateStore` over world dynamic properties. One instance per script world. */
export class BedrockWorldStateStore implements StateStore {
  readonly #world: DynamicPropertyHost;
  readonly #maxIdentifierLength: number;
  readonly #maxValueLength: number;

  constructor(world: DynamicPropertyHost, options: BedrockStateStoreOptions = {}) {
    if (world === null || typeof world !== "object") {
      throw new TypeError(
        "world must be an object with getDynamicProperty/setDynamicProperty",
      );
    }
    for (const method of ["getDynamicProperty", "setDynamicProperty"] as const) {
      if (typeof world[method] !== "function") {
        throw new TypeError(`world.${method} must be a function`);
      }
    }

    const {
      maxIdentifierLength = BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH,
      maxValueLength = BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH,
    } = options;

    this.#world = world;
    this.#maxIdentifierLength = assertPositiveSafeInteger(
      maxIdentifierLength,
      "maxIdentifierLength",
    );
    this.#maxValueLength = assertPositiveSafeInteger(maxValueLength, "maxValueLength");
  }

  /**
   * Dynamic property identifier used for a state store key, including the
   * generation prefix. Throws `IDENTIFIER_TOO_LONG` when the *encoded*
   * identifier exceeds the engine limit, before the world is ever called.
   */
  identifierFor(key: string): string {
    const identifier = toIdentifier(assertKey(key));
    if (identifier.length > this.#maxIdentifierLength) {
      throw new BedrockStoreError(
        "IDENTIFIER_TOO_LONG",
        `Dynamic property identifier is ${identifier.length} characters after ` +
          `encoding; the limit is ${this.#maxIdentifierLength}. ` +
          "The world was not called.",
      );
    }
    return identifier;
  }

  getItem(key: string): string | undefined {
    const identifier = this.identifierFor(key);
    const value = this.#world.getDynamicProperty(identifier);
    if (value === undefined || value === null) {
      // Disjoint generation spaces: an identifier this generation writes is
      // never a legacy identifier, so this lookup can only find old state.
      const legacyIdentifier = toLegacyIdentifier(key);
      const legacyValue = this.#world.getDynamicProperty(legacyIdentifier);
      if (legacyValue !== undefined && legacyValue !== null) {
        throw new BedrockStoreError(
          "LEGACY_IDENTIFIER_CONFLICT",
          `Dynamic property ${identifier} is absent, but the legacy-encoded ` +
            `property ${legacyIdentifier} holds a value. The legacy ` +
            "variable-width encoding was not injective, so that value cannot " +
            "be safely attributed to this key; it was not returned and both " +
            "properties were left untouched. Manual investigation is " +
            "required before this state is read or overwritten.",
        );
      }
      return undefined;
    }
    if (typeof value !== "string") {
      throw new BedrockStoreError(
        "INVALID_STORED_VALUE",
        `Dynamic property ${identifier} holds a ${typeof value}, not a string. ` +
          "It was left untouched; remove or repair it explicitly.",
      );
    }
    return value;
  }

  setItem(key: string, value: string): void {
    const identifier = this.identifierFor(key);
    if (typeof value !== "string") {
      throw new TypeError("state store value must be a string");
    }
    const bytes = utf8ByteLength(value);
    if (bytes > this.#maxValueLength) {
      throw new BedrockStoreError(
        "VALUE_TOO_LARGE",
        `Dynamic property ${identifier} would be ${bytes} UTF-8 bytes; ` +
          `the guard is ${this.#maxValueLength}. The state was not written.`,
      );
    }
    this.#world.setDynamicProperty(identifier, value);
  }

  removeItem(key: string): void {
    const identifier = this.identifierFor(key);
    // This deletes only the tagged identifier; legacy state at the
    // variable-width identifier is never reachable from here.
    // An omitted/undefined value deletes the property on Bedrock.
    this.#world.setDynamicProperty(identifier, undefined);
  }
}
