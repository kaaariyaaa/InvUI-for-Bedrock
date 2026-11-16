/** State validation, identity normalization, and serialization helpers. */
import { createJsonCloner, hasOwn, isPlainObject, MAX_JSON_DEPTH } from "./json.js";
import type {
  GuiState,
  GuiStatePatch,
  GuiStateField,
  StateSnapshot,
  StateScope,
  StateLifetime,
  StateAcquireOptions,
  StateMigrationOptions,
  StateAutoMigration,
  StateRemoveOptions,
  StateManagerOptions,
  StateStore,
  StoredGuiState,
  StateHandle,
  StateListener,
  StateUnsubscribe,
  StateMigration,
  StateErrorCode,
} from "./state-types.js";
import {
  StateValidationError,
  StateConflictError,
  StateCorruptionError,
  StateReleasedError,
  StateError,
  STATE_STORAGE_VERSION,
} from "./state-types.js";

export const STATE_FIELDS: readonly GuiStateField[] = [
  "page",
  "line",
  "tab",
  "selection",
  "data",
  "tabs",
  "children",
];
export const FIELD_SET = new Set<string>(STATE_FIELDS);
export const ACQUIRE_KEYS = new Set([
  "scope",
  "key",
  "ownerId",
  "lifetime",
  "schema",
  "initial",
]);
export const MIGRATION_KEYS = new Set([
  "scope",
  "key",
  "ownerId",
  "fromVersion",
  "fromSchema",
  "schema",
]);
export const REMOVE_KEYS = new Set(["scope", "key", "ownerId"]);
export const MANAGER_KEYS = new Set(["onError", "quarantineCorrupt", "migrations"]);
export const EMPTY_STATE: StateSnapshot = Object.freeze({});
export const EMPTY_CHANGED: readonly GuiStateField[] = Object.freeze([]);
export const EMPTY_MIGRATIONS: readonly NormalizedAutoMigration[] = Object.freeze([]);
/**
 * Upper bound for the `...:quarantine` slot search. A store whose `getItem`
 * reports every slot as occupied must make `acquire` fail closed instead of
 * looping forever. Raise it only if one key ever needs more retained backups.
 * ponytail: bounded scan, raise if 1000 backups per key is ever not enough.
 */
export const MAX_QUARANTINE_SLOTS = 1000;

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StateValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireNonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new StateValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

export function requireSelection(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new StateValidationError(`${label} must be a string`);
  }
  return value;
}

/**
 * Validated, deep-cloned, and deep-frozen copy of a JSON value. Container
 * shapes are read the way `JSON.stringify` reads them; unlike `inventory.ts`
 * this copy is frozen. See `json.ts` for the shared walk.
 */
export const cloneJsonValue = createJsonCloner({
  fail: (message) => new StateValidationError(message),
  freeze: true,
});

export function isCanonicalIndex(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key));
}

/**
 * Validates and freezes a `tabs`/`children` map. Keys are validated (tab
 * indexes must stay non-negative integers) and every value is a GUI state.
 */
export function cloneStateMap(
  input: unknown,
  label: string,
  requireIndexKeys: boolean,
  depth: number,
): Record<string, StateSnapshot> {
  if (!isPlainObject(input)) {
    throw new StateValidationError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new StateValidationError(`${label} contains symbol keys`);
  }

  const record: Record<string, StateSnapshot> = {};
  for (const key of Object.keys(input)) {
    if (requireIndexKeys && !isCanonicalIndex(key)) {
      throw new StateValidationError(
        `${label} key "${key}" must be a non-negative integer`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new StateValidationError(`${label}.${key} must be a data property`);
    }
    Object.defineProperty(record, key, {
      value: cloneState(descriptor.value, `${label}.${key}`, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(record);
}

/** Validates and freezes a GUI state object, rejecting unknown fields. */
export function cloneState(
  input: unknown,
  label: string,
  depth = 0,
): StateSnapshot {
  if (!isPlainObject(input)) {
    throw new StateValidationError(`${label} must be a plain object`);
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new StateValidationError(`${label} is nested too deeply`);
  }
  for (const key of Object.keys(input)) {
    if (!FIELD_SET.has(key)) {
      throw new StateValidationError(`${label} has unknown field "${key}"`);
    }
  }

  const state: GuiState = {};
  if (hasOwn(input, "page")) {
    state.page = requireNonNegativeInteger(input.page, `${label}.page`);
  }
  if (hasOwn(input, "line")) {
    state.line = requireNonNegativeInteger(input.line, `${label}.line`);
  }
  if (hasOwn(input, "tab")) {
    state.tab = requireNonNegativeInteger(input.tab, `${label}.tab`);
  }
  if (hasOwn(input, "selection")) {
    state.selection = requireSelection(input.selection, `${label}.selection`);
  }
  if (hasOwn(input, "data")) {
    state.data = cloneJsonValue(input.data, `${label}.data`);
  }
  if (hasOwn(input, "tabs")) {
    state.tabs = cloneStateMap(
      input.tabs,
      `${label}.tabs`,
      true,
      depth,
    ) as unknown as Record<number, GuiState>;
  }
  if (hasOwn(input, "children")) {
    state.children = cloneStateMap(
      input.children,
      `${label}.children`,
      false,
      depth,
    );
  }
  return Object.freeze(state);
}

export function mergeState(
  current: StateSnapshot,
  patch: StateSnapshot,
): { state: StateSnapshot; changed: readonly GuiStateField[] } {
  const next: GuiState = { ...current };
  const changed: GuiStateField[] = [];

  if (hasOwn(patch, "page")) {
    const value = patch.page as number;
    if (!Object.is(current.page, value)) {
      next.page = value;
      changed.push("page");
    }
  }
  if (hasOwn(patch, "line")) {
    const value = patch.line as number;
    if (!Object.is(current.line, value)) {
      next.line = value;
      changed.push("line");
    }
  }
  if (hasOwn(patch, "tab")) {
    const value = patch.tab as number;
    if (!Object.is(current.tab, value)) {
      next.tab = value;
      changed.push("tab");
    }
  }
  if (hasOwn(patch, "selection")) {
    const value = patch.selection as string;
    if (!Object.is(current.selection, value)) {
      next.selection = value;
      changed.push("selection");
    }
  }
  if (hasOwn(patch, "data")) {
    if (!Object.is(current.data, patch.data)) {
      next.data = patch.data;
      changed.push("data");
    }
  }
  if (hasOwn(patch, "tabs")) {
    if (!Object.is(current.tabs, patch.tabs)) {
      next.tabs = patch.tabs;
      changed.push("tabs");
    }
  }
  if (hasOwn(patch, "children")) {
    if (!Object.is(current.children, patch.children)) {
      next.children = patch.children;
      changed.push("children");
    }
  }

  if (changed.length === 0) {
    return { state: current, changed: EMPTY_CHANGED };
  }
  return {
    state: Object.freeze(next),
    changed: Object.freeze(changed),
  };
}

export interface NormalizedAcquireOptions {
  scope: StateScope;
  key: string;
  ownerId: string | undefined;
  lifetime: StateLifetime;
  schema: string;
  initial: StateSnapshot;
}

export interface NormalizedIdentityOptions {
  scope: StateScope;
  key: string;
  ownerId: string | undefined;
}

/** A decoded store record plus the raw string it came from. */
export interface StoredRead {
  raw: string;
  parsed: Record<string, unknown>;
}

export function normalizeIdentityOptions(
  input: Record<string, unknown>,
): NormalizedIdentityOptions {
  const scope = input.scope ?? "player";
  if (scope !== "player" && scope !== "shared") {
    throw new StateValidationError(
      'scope must be "player" or "shared"',
    );
  }

  let key: string;
  if (input.key === undefined) {
    if (scope === "shared") {
      throw new StateValidationError("shared scope requires a state key");
    }
    key = "default";
  } else {
    key = requireNonEmptyString(input.key, "key");
  }

  let ownerId: string | undefined;
  if (scope === "player") {
    ownerId = requireNonEmptyString(input.ownerId, "ownerId");
  } else if (input.ownerId !== undefined) {
    throw new StateValidationError(
      "shared scope must not specify ownerId",
    );
  }

  return { scope, key, ownerId };
}

export function normalizeAcquireOptions(input: unknown): NormalizedAcquireOptions {
  if (!isPlainObject(input)) {
    throw new StateValidationError("acquire options must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!ACQUIRE_KEYS.has(key)) {
      throw new StateValidationError(`unknown acquire option "${key}"`);
    }
  }

  const identity = normalizeIdentityOptions(input);
  const lifetime = input.lifetime ?? "window";
  if (
    lifetime !== "window" &&
    lifetime !== "session" &&
    lifetime !== "persistent"
  ) {
    throw new StateValidationError(
      'lifetime must be "window", "session", or "persistent"',
    );
  }

  const schema =
    input.schema === undefined
      ? "default"
      : requireNonEmptyString(input.schema, "schema");

  const initial =
    input.initial === undefined
      ? EMPTY_STATE
      : cloneState(input.initial, "initial");

  return { ...identity, lifetime, schema, initial };
}

export interface NormalizedMigrationOptions extends NormalizedIdentityOptions {
  fromVersion: number;
  fromSchema: string | null;
  schema: string;
}

/** A validated declaration from {@link StateManagerOptions.migrations}. */
export interface NormalizedAutoMigration extends NormalizedMigrationOptions {
  identity: string;
  migrate: StateMigration;
}

export function normalizeRemoveOptions(input: unknown): NormalizedIdentityOptions {
  if (!isPlainObject(input)) {
    throw new StateValidationError("remove options must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!REMOVE_KEYS.has(key)) {
      throw new StateValidationError(`unknown remove option "${key}"`);
    }
  }
  return normalizeIdentityOptions(input);
}

export function normalizeMigrationOptions(
  input: unknown,
): NormalizedMigrationOptions {
  if (!isPlainObject(input)) {
    throw new StateValidationError("migration options must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!MIGRATION_KEYS.has(key)) {
      throw new StateValidationError(`unknown migration option "${key}"`);
    }
  }

  const identity = normalizeIdentityOptions(input);
  const fromVersion = requireNonNegativeInteger(
    input.fromVersion,
    "fromVersion",
  );
  if (!hasOwn(input, "fromSchema")) {
    throw new StateValidationError(
      'fromSchema is required (use null for records written before schemas existed)',
    );
  }
  const fromSchema =
    input.fromSchema === null
      ? null
      : requireNonEmptyString(input.fromSchema, "fromSchema");
  if (!hasOwn(input, "schema")) {
    throw new StateValidationError("migration schema is required");
  }
  const schema = requireNonEmptyString(input.schema, "schema");
  if (fromVersion === STATE_STORAGE_VERSION && fromSchema === schema) {
    throw new StateValidationError(
      `migration from version ${fromVersion} schema ${JSON.stringify(fromSchema)} to the same version and schema is rejected; the record is already current`,
    );
  }
  return { ...identity, fromVersion, fromSchema, schema };
}

export function normalizeAutoMigrations(
  input: unknown,
): readonly NormalizedAutoMigration[] {
  if (input === undefined) {
    return EMPTY_MIGRATIONS;
  }
  if (!Array.isArray(input)) {
    throw new StateValidationError("migrations must be an array");
  }
  const seen = new Set<string>();
  const migrations: NormalizedAutoMigration[] = [];
  for (const declaration of input) {
    if (!isPlainObject(declaration)) {
      throw new StateValidationError("each migration must be a plain object");
    }
    const migrate = declaration.migrate;
    if (typeof migrate !== "function") {
      throw new StateValidationError("migration migrate must be a function");
    }
    const { migrate: _ignored, ...options } = declaration;
    const normalized = normalizeMigrationOptions(options);
    const identity = identityOf(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );
    const source = JSON.stringify([
      identity,
      normalized.fromVersion,
      normalized.fromSchema,
    ]);
    if (seen.has(source)) {
      throw new StateValidationError(
        `duplicate automatic migration for ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} from version ${normalized.fromVersion} schema ${JSON.stringify(normalized.fromSchema)}`,
      );
    }
    seen.add(source);
    migrations.push({
      ...normalized,
      identity,
      migrate: migrate as StateMigration,
    });
  }
  return Object.freeze(migrations);
}

export function identityOf(
  scope: StateScope,
  ownerId: string | undefined,
  key: string,
): string {
  // JSON keeps arbitrary key/owner strings (including control characters)
  // collision-free. It is also a stable store key component.
  return JSON.stringify([scope, ownerId ?? null, key]);
}

export function storageKeyOf(identity: string): string {
  return `invui:gui-state:${identity}`;
}

/**
 * Stored lifetime, defaulting to `persistent` when the field is absent. Design
 * 9.6 predates the field, so a record in exactly that documented shape has no
 * `lifetime` even though it can only describe a persisted state. Reading it as
 * anything else would make the documented shape unloadable.
 */
export function storedLifetimeOf(record: Record<string, unknown>): unknown {
  return hasOwn(record, "lifetime") ? record.lifetime : "persistent";
}

/**
 * Stored schema, defaulting to `null` (schema-less) when the field is absent,
 * matching {@link StateMigrationOptions.fromSchema}'s meaning for design 9.6
 * records.
 */
export function storedSchemaOf(record: Record<string, unknown>): unknown {
  return hasOwn(record, "schema") ? record.schema : null;
}

export function describeIdentity(
  scope: StateScope,
  ownerId: string | undefined,
  key: string,
): string {
  return scope === "shared"
    ? `shared key "${key}"`
    : `player "${ownerId ?? ""}" key "${key}"`;
}
