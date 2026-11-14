/**
 * GUI state management (design chapters 9 and 12).
 *
 * This module is intentionally independent from the Bedrock Script API. All
 * persistence is delegated to an injected synchronous string store, which keeps
 * the state machine testable outside Minecraft.
 */

import {
  createJsonCloner,
  hasOwn,
  isPlainObject,
  MAX_JSON_DEPTH,
} from "./json.js";

export type StateScope = "player" | "shared";
export type StateLifetime = "window" | "session" | "persistent";

/** Bump when the persisted record layout changes. */
export const STATE_STORAGE_VERSION = 1;

export type GuiStateField =
  | "page"
  | "line"
  | "tab"
  | "selection"
  | "data"
  | "tabs"
  | "children";

export interface GuiState {
  page?: number;
  line?: number;
  tab?: number;
  selection?: string;
  data?: unknown;
  /** Per-tab state, keyed by tab index. Matches the GUI layout's nested state. */
  tabs?: Record<number, GuiState>;
  /** Per-GuiLink state, keyed by GuiLink option `key`. */
  children?: Record<string, GuiState>;
}

/** Patch accepted by {@link StateHandle.set}. Absent fields are unchanged. */
export type GuiStatePatch = GuiState;

export type StateSnapshot = Readonly<GuiState>;

/**
 * Persisted form from design 9.6. `lifetime` and `schema` are included so a
 * reload can reject incompatible registrations instead of mixing states.
 */
export interface StoredGuiState {
  version: number;
  scope: StateScope;
  key: string;
  ownerId?: string;
  lifetime: StateLifetime;
  schema: string;
  guiState: GuiState;
}

/**
 * Synchronous persistence port. `getItem` returns `null`/`undefined` when the
 * key is absent. Implementations may throw; the error propagates to the caller
 * and the in-memory state is not committed.
 *
 * Writes are not rolled back. A store that throws after partially applying a
 * write can leave the new record in place while the in-memory state keeps the
 * old value, so a later `acquire` may load data the manager never committed.
 * Implement `setItem` as one atomic write of the whole value to avoid that.
 * `removeItem` has the same caveat: a store that deleted the record and then
 * threw leaves it gone, and the deletion is not restored.
 */
export interface StateStore {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StateManagerOptions {
  /**
   * Receives isolated errors that must not break state processing, such as a
   * subscriber throwing. With {@link StateManagerOptions.quarantineCorrupt}
   * enabled, a recovered corrupt record is reported here; otherwise corrupt
   * persisted data is surfaced as a {@link StateCorruptionError} from
   * `acquire`.
   */
  onError?: (error: unknown) => void;
  /**
   * Opt-in automatic recovery of corrupt persisted records. When `acquire`
   * cannot decode or validate a stored record, its raw string is copied to a
   * free `...:quarantine` key next to the record, the original key is removed,
   * and the corruption is reported through {@link onError}. The acquire then
   * starts from `initial` and persists it, as if no record existed.
   *
   * Defaults to false: the record is left untouched and `acquire` throws a
   * {@link StateCorruptionError}, so a human can inspect it. Recovery applies
   * only to `acquire`; `migrate` still fails closed. The raw value that failed
   * decoding is copied verbatim. If the copy fails, the store error propagates
   * and the original record is untouched. If the copy succeeds but the deletion
   * fails, both remain and a retry reuses the existing backup. A value that
   * changed between decoding and deletion is never deleted. A store that
   * reports every quarantine key as occupied fails closed after a bounded
   * number of attempts.
   *
   * The identity stays locked while the copy, the deletion, and the
   * {@link onError} report run: a reentrant `acquire`, `migrate`, or `remove`
   * for it (from the store or from the callback) throws a `LIVE_STATE`
   * {@link StateConflictError}, so recovery cannot leave a second live entry
   * behind.
   */
  quarantineCorrupt?: boolean;
  /**
   * Declarative migrations that {@link StateManager.acquire} applies
   * automatically to a persisted record whose stored `version`/`schema`
   * exactly matches a declared source and whose declared target `schema`
   * equals the schema being acquired. This is the automatic counterpart to
   * the explicit {@link StateManager.migrate} call.
   *
   * Defaults to none: a version/schema mismatch fails closed with
   * {@link StateConflictError}, exactly as before. A match is applied only to
   * `persistent` registrations, and only to a record whose identity and
   * lifetime already match. A record without `lifetime`/`schema` is the design
   * 9.6 shape and is read as persistent and schema-less, so declaring
   * `fromSchema: null` migrates it even when its stored version is already
   * current. The decoded legacy record (any shape) is passed
   * to the callback; the returned GUI state is validated and the migrated
   * record is written only after both succeed, so a throwing or invalid
   * callback leaves the stored record untouched. The callback runs under the
   * same identity lock as `migrate`: a reentrant `acquire`/`migrate`/`remove`
   * for the identity fails with `LIVE_STATE`.
   *
   * At most one migration may be declared per identity and source
   * version/schema; a duplicate is rejected at construction.
   */
  migrations?: readonly StateAutoMigration[];
}

export interface StateAcquireOptions {
  /** Defaults to `"player"`. */
  scope?: StateScope;
  /** Required for `shared`; defaults to `"default"` for `player`. */
  key?: string;
  /** Required for `player`; rejected for `shared`. */
  ownerId?: string;
  /** Defaults to `"window"`. */
  lifetime?: StateLifetime;
  /**
   * Opaque compatibility token supplied by the GUI definition (for example a
   * structure hash). Different tokens for the same key are rejected.
   * Defaults to `"default"`.
   */
  schema?: string;
  /** Used only when no state exists yet. Ignored for a live/persisted state. */
  initial?: GuiState;
}

/** Identity and source/target schema for {@link StateManager.migrate}. */
export interface StateMigrationOptions {
  /** Defaults to `"player"`. */
  scope?: StateScope;
  /** Required for `shared`; defaults to `"default"` for `player`. */
  key?: string;
  /** Required for `player`; rejected for `shared`. */
  ownerId?: string;
  /** Required. Exact stored `version` the migration expects to read. */
  fromVersion: number;
  /**
   * Required. Exact stored `schema` the migration expects to read. Use `null`
   * for records written before schemas existed (the design 9.6 shape).
   */
  fromSchema: string | null;
  /** Required. Schema recorded on the migrated state. */
  schema: string;
}

/**
 * Receives the decoded persisted value, which may use any older shape, and
 * returns the GUI state for the current storage version.
 */
export type StateMigration = (legacy: unknown) => GuiState;

/**
 * A migration declared in {@link StateManagerOptions.migrations} that
 * `acquire` applies automatically. The source `fromVersion`/`fromSchema` and
 * target `schema` use the same meaning as {@link StateManager.migrate}.
 */
export interface StateAutoMigration extends StateMigrationOptions {
  migrate: StateMigration;
}

/**
 * Identity of the persisted record {@link StateManager.remove} deletes.
 * The same identity rules as {@link StateAcquireOptions} apply.
 */
export interface StateRemoveOptions {
  /** Defaults to `"player"`. */
  scope?: StateScope;
  /** Required for `shared`; defaults to `"default"` for `player`. */
  key?: string;
  /** Required for `player`; rejected for `shared`. */
  ownerId?: string;
}

export type StateUnsubscribe = () => void;

export type StateListener = (
  state: StateSnapshot,
  changed: readonly GuiStateField[],
) => void;

/**
 * A Window's lease on a state. All handles for the same (scope, owner, key)
 * share one state object and one async queue.
 */
export interface StateHandle {
  readonly scope: StateScope;
  readonly key: string;
  readonly lifetime: StateLifetime;
  readonly ownerId: string | undefined;
  readonly schema: string;
  readonly released: boolean;

  /** Latest immutable snapshot. Throws after release. */
  get(): StateSnapshot;

  /**
   * Merge a validated patch synchronously. Persistent states are written to
   * the store before the change is committed, and subscribers are notified
   * afterwards.
   *
   * A throwing store write aborts the commit: in-memory state and subscribers
   * stay on the previous value. The write itself is not rolled back, so a
   * store that partially applied it and then threw may already hold the new
   * record (see {@link StateStore}).
   *
   * The identity is locked while the store write runs: a store hook that
   * reentrantly calls `acquire`, `migrate`, `remove`, or `set` for the same
   * identity gets a `LIVE_STATE` {@link StateConflictError}. Without that lock
   * the reentrant commit would be overwritten by this one after the store
   * returned, silently losing it (and leaving memory and the record disagree).
   *
   * Notification is synchronous. A subscriber may call `set` reentrantly; that
   * newer commit supersedes the notification in progress, so every remaining
   * subscriber receives the newer snapshot instead of finishing on a stale
   * one. Remaining subscribers also receive the union of the fields changed by
   * the superseded commits, since they never saw those notifications.
   */
  set(patch: GuiStatePatch): StateSnapshot;

  subscribe(listener: StateListener): StateUnsubscribe;

  /**
   * Queue work against this handle's state identity. Tasks for the same name
   * run strictly one after another; tasks for different identities may overlap.
   * Queued tasks are rejected with {@link StateReleasedError} if this handle
   * (or a `window`-lifetime state) is released before they start.
   *
   * The queue is FIFO, so awaiting another `enqueue` or `update` for the same
   * identity from inside a queued task deadlocks: the inner call cannot start
   * until the outer task settles, and the outer task is waiting for it.
   *
   * `enqueue` only serializes tasks; it does not make read-modify-write atomic.
   * When the result depends on the current state, use {@link update}.
   */
  enqueue<T>(task: () => T | Promise<T>): Promise<T>;

  /**
   * Atomic read-modify-write inside the same identity queue. The updater
   * receives the snapshot at execution time; its result is validated and
   * committed via {@link StateHandle.set}. If the state changed while an async
   * updater was running, or the handle was released, nothing is written.
   *
   * Awaiting another `enqueue` or `update` for the same identity from inside
   * `updater` deadlocks for the same FIFO reason as {@link enqueue}.
   */
  update(
    updater: (
      state: StateSnapshot,
    ) => GuiStatePatch | Promise<GuiStatePatch>,
  ): Promise<StateSnapshot>;

  /** Idempotent. Releases the lease; `window` state is discarded at refcount 0. */
  release(): void;
}

export type StateErrorCode =
  | "INVALID_STATE"
  | "SCHEMA_MISMATCH"
  | "LIFETIME_MISMATCH"
  | "IDENTITY_MISMATCH"
  | "VERSION_MISMATCH"
  | "STALE_STATE"
  | "LIVE_STATE"
  | "MISSING_STATE"
  | "RELEASED"
  | "CORRUPT_STORE";

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid caller input. Raised before any state or store mutation. */
export class StateValidationError extends StateError {
  constructor(message: string) {
    super("INVALID_STATE", message);
  }
}

/** Two registrations (live or persisted) disagree about compatibility. */
export class StateConflictError extends StateError {
  constructor(
    code:
      | "SCHEMA_MISMATCH"
      | "LIFETIME_MISMATCH"
      | "IDENTITY_MISMATCH"
      | "VERSION_MISMATCH"
      | "STALE_STATE"
      | "LIVE_STATE"
      | "MISSING_STATE",
    message: string,
  ) {
    super(code, message);
  }
}

/** The handle or its state was released; the operation was discarded. */
export class StateReleasedError extends StateError {
  constructor(message = "State handle has been released") {
    super("RELEASED", message);
  }
}

/**
 * Persisted data could not be decoded. By default the stored record is left
 * untouched and acquisition fails closed so the next write cannot destroy
 * recoverable data. With {@link StateManagerOptions.quarantineCorrupt} enabled,
 * `acquire` quarantines the raw record and starts from `initial` instead.
 */
export class StateCorruptionError extends StateError {
  constructor(message: string) {
    super("CORRUPT_STORE", message);
  }
}

const STATE_FIELDS: readonly GuiStateField[] = [
  "page",
  "line",
  "tab",
  "selection",
  "data",
  "tabs",
  "children",
];
const FIELD_SET = new Set<string>(STATE_FIELDS);
const ACQUIRE_KEYS = new Set([
  "scope",
  "key",
  "ownerId",
  "lifetime",
  "schema",
  "initial",
]);
const MIGRATION_KEYS = new Set([
  "scope",
  "key",
  "ownerId",
  "fromVersion",
  "fromSchema",
  "schema",
]);
const REMOVE_KEYS = new Set(["scope", "key", "ownerId"]);
const MANAGER_KEYS = new Set(["onError", "quarantineCorrupt", "migrations"]);
const EMPTY_STATE: StateSnapshot = Object.freeze({});
const EMPTY_CHANGED: readonly GuiStateField[] = Object.freeze([]);
const EMPTY_MIGRATIONS: readonly NormalizedAutoMigration[] = Object.freeze([]);
/**
 * Upper bound for the `...:quarantine` slot search. A store whose `getItem`
 * reports every slot as occupied must make `acquire` fail closed instead of
 * looping forever. Raise it only if one key ever needs more retained backups.
 * ponytail: bounded scan, raise if 1000 backups per key is ever not enough.
 */
const MAX_QUARANTINE_SLOTS = 1000;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StateValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
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

function requireSelection(value: unknown, label: string): string {
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
const cloneJsonValue = createJsonCloner({
  fail: (message) => new StateValidationError(message),
  freeze: true,
});

function isCanonicalIndex(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key));
}

/**
 * Validates and freezes a `tabs`/`children` map. Keys are validated (tab
 * indexes must stay non-negative integers) and every value is a GUI state.
 */
function cloneStateMap(
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
function cloneState(
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

function mergeState(
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

interface NormalizedAcquireOptions {
  scope: StateScope;
  key: string;
  ownerId: string | undefined;
  lifetime: StateLifetime;
  schema: string;
  initial: StateSnapshot;
}

interface NormalizedIdentityOptions {
  scope: StateScope;
  key: string;
  ownerId: string | undefined;
}

/** A decoded store record plus the raw string it came from. */
interface StoredRead {
  raw: string;
  parsed: Record<string, unknown>;
}

function normalizeIdentityOptions(
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

function normalizeAcquireOptions(input: unknown): NormalizedAcquireOptions {
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

interface NormalizedMigrationOptions extends NormalizedIdentityOptions {
  fromVersion: number;
  fromSchema: string | null;
  schema: string;
}

/** A validated declaration from {@link StateManagerOptions.migrations}. */
interface NormalizedAutoMigration extends NormalizedMigrationOptions {
  identity: string;
  migrate: StateMigration;
}

function normalizeRemoveOptions(input: unknown): NormalizedIdentityOptions {
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

function normalizeMigrationOptions(
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

function normalizeAutoMigrations(
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

function identityOf(
  scope: StateScope,
  ownerId: string | undefined,
  key: string,
): string {
  // JSON keeps arbitrary key/owner strings (including control characters)
  // collision-free. It is also a stable store key component.
  return JSON.stringify([scope, ownerId ?? null, key]);
}

function storageKeyOf(identity: string): string {
  return `invui:gui-state:${identity}`;
}

/**
 * Stored lifetime, defaulting to `persistent` when the field is absent. Design
 * 9.6 predates the field, so a record in exactly that documented shape has no
 * `lifetime` even though it can only describe a persisted state. Reading it as
 * anything else would make the documented shape unloadable.
 */
function storedLifetimeOf(record: Record<string, unknown>): unknown {
  return hasOwn(record, "lifetime") ? record.lifetime : "persistent";
}

/**
 * Stored schema, defaulting to `null` (schema-less) when the field is absent,
 * matching {@link StateMigrationOptions.fromSchema}'s meaning for design 9.6
 * records.
 */
function storedSchemaOf(record: Record<string, unknown>): unknown {
  return hasOwn(record, "schema") ? record.schema : null;
}

function describeIdentity(
  scope: StateScope,
  ownerId: string | undefined,
  key: string,
): string {
  return scope === "shared"
    ? `shared key "${key}"`
    : `player "${ownerId ?? ""}" key "${key}"`;
}

interface StateEntry {
  readonly identity: string;
  readonly scope: StateScope;
  readonly key: string;
  readonly ownerId: string | undefined;
  readonly lifetime: StateLifetime;
  readonly schema: string;
  state: StateSnapshot;
  readonly handles: Set<StateHandleImpl>;
  tail: Promise<void>;
  /** Incremented on each committed change; detects reentrant commits. */
  generation: number;
  /** Active notification cascade, or undefined outside a commit. */
  notification: NotificationPass | undefined;
  released: boolean;
}

/**
 * Bookkeeping for one synchronous notification cascade. A listener may commit
 * reentrantly, which aborts the pass in progress; the newest pass then has to
 * tell the not-yet-notified listeners about every field that changed since
 * their last delivery.
 */
interface NotificationPass {
  /** Union of the fields changed by every commit in this cascade, in order. */
  changed: GuiStateField[];
  /**
   * Listeners that already received a commit in this cascade, keyed by the
   * handle they subscribed on. Registrations are tracked separately: the same
   * function subscribed to two handles is two subscribers, so the second one
   * must still receive the union of the changes it missed.
   */
  delivered: Map<StateHandle, Set<StateListener>>;
}

/**
 * Runtime internals of a handle, kept in a module-private WeakMap so the
 * mutable entry (and the manager itself) is never reachable from the public
 * `StateHandle` surface. Nothing outside this module can forge or mutate a
 * contract the manager accepts.
 */
interface HandleInternals {
  readonly manager: StateManager;
  readonly entry: StateEntry;
  active: boolean;
  readonly listeners: Set<StateListener>;
}

const HANDLE_INTERNALS = new WeakMap<StateHandle, HandleInternals>();

function internalsOf(handle: StateHandle): HandleInternals {
  const internals = HANDLE_INTERNALS.get(handle);
  if (internals === undefined) {
    throw new StateValidationError(
      "handle was not created by this StateManager",
    );
  }
  return internals;
}

function requireInternals(
  handle: StateHandle,
  manager: StateManager,
): HandleInternals {
  const internals = internalsOf(handle);
  if (internals.manager !== manager) {
    throw new StateValidationError(
      "handle was not created by this StateManager",
    );
  }
  return internals;
}

/**
 * Owns state identities, leases, subscriptions, persistence, and per-identity
 * async ordering. One instance is expected per script generation.
 *
 * The manager is the sole writer for the identities it owns: it caches state in
 * memory and writes whole records. Changes made to the injected store by
 * another manager or by outside code are neither observed nor merged, and the
 * next commit overwrites them. Share one manager per store instead of relying
 * on cross-manager synchronization.
 */
export class StateManager {
  readonly #store: StateStore | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #quarantineCorrupt: boolean;
  readonly #migrations: readonly NormalizedAutoMigration[];
  readonly #entries = new Map<string, StateEntry>();
  /**
   * Identities whose record is being mutated: a running migration callback, a
   * running `store.removeItem`, the load/seed phase of an `acquire` (which may
   * quarantine a corrupt record), or the `store.setItem` of a persistent
   * `set`. `acquire`, `migrate`, `remove`, and `_set` reject these so a
   * reentrant call from inside a callback or a store hook cannot resurrect a
   * stale entry, register a lease that survives the mutation, delete a record
   * the mutation is still writing, or overwrite a reentrant commit after the
   * store accepted it.
   */
  readonly #mutating = new Set<string>();

  constructor(
    store?: StateStore | null,
    options: StateManagerOptions = {},
  ) {
    if (store !== undefined && store !== null) {
      if (typeof store !== "object") {
        throw new StateValidationError(
          "store must be an object with getItem/setItem/removeItem",
        );
      }
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        if (typeof store[method] !== "function") {
          throw new StateValidationError(
            `store.${method} must be a function`,
          );
        }
      }
    }
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new StateValidationError("manager options must be an object");
    }
    for (const key of Object.keys(options)) {
      if (!MANAGER_KEYS.has(key)) {
        throw new StateValidationError(`unknown manager option "${key}"`);
      }
    }
    if (
      options.onError !== undefined &&
      typeof options.onError !== "function"
    ) {
      throw new StateValidationError("onError must be a function");
    }
    if (
      options.quarantineCorrupt !== undefined &&
      typeof options.quarantineCorrupt !== "boolean"
    ) {
      throw new StateValidationError("quarantineCorrupt must be a boolean");
    }

    this.#store = store ?? undefined;
    this.#onError = options.onError;
    this.#quarantineCorrupt = options.quarantineCorrupt === true;
    this.#migrations = normalizeAutoMigrations(options.migrations);
  }

  /**
   * Registers a Window's interest in a state identity and returns its lease.
   * The state starts from the live value, then persisted data (applying a
   * declared {@link StateManagerOptions.migrations} match when one exists),
   * then `initial`.
   *
   * Acquiring an identity whose automatic-migration callback,
   * {@link migrate} callback, {@link remove} store call, persistent
   * {@link StateHandle.set} store write, or `quarantineCorrupt` recovery is
   * running throws a `LIVE_STATE` {@link StateConflictError}; other identities
   * are unaffected.
   */
  acquire(options: StateAcquireOptions): StateHandle {
    const optionsInput: unknown = options;
    const normalized = normalizeAcquireOptions(optionsInput);
    const identity = identityOf(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );

    if (this.#mutating.has(identity)) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} is being migrated, removed, or recovered; acquire it after the operation settles`,
      );
    }

    let entry = this.#entries.get(identity);
    if (entry !== undefined) {
      this.#assertCompatible(entry, normalized);

      const existing = new StateHandleImpl(this, entry);
      entry.handles.add(existing);
      return existing;
    }

    let state = normalized.initial;
    if (normalized.lifetime === "persistent" && this.#store === undefined) {
      throw new StateValidationError(
        "persistent lifetime requires an injected state store",
      );
    }
    if (this.#store !== undefined) {
      // Lock the identity while its record is read and, for persistent states,
      // seeded. With `quarantineCorrupt` this covers the quarantine and the
      // `onError` report, so neither a store hook nor the callback can open a
      // second live entry for the identity while recovery is in progress.
      this.#mutating.add(identity);
      try {
        // Peek even for non-persistent lifetimes so a stored persistent record
        // under the same key is rejected as a lifetime/schema conflict instead
        // of silently coexisting with a new in-memory state.
        const loaded = this.#loadPersistent(normalized, identity);
        if (normalized.lifetime === "persistent") {
          if (loaded !== null) {
            state = loaded;
          } else {
            // Persist the first value immediately so a reload before any change
            // still restores the declared initial state.
            this.#savePersistent(identity, normalized, state);
          }
        }
      } finally {
        this.#mutating.delete(identity);
      }
    }

    entry = {
      identity,
      scope: normalized.scope,
      key: normalized.key,
      ownerId: normalized.ownerId,
      lifetime: normalized.lifetime,
      schema: normalized.schema,
      state,
      handles: new Set(),
      tail: Promise.resolve(),
      generation: 0,
      notification: undefined,
      released: false,
    };
    this.#entries.set(identity, entry);

    const handle = new StateHandleImpl(this, entry);
    entry.handles.add(handle);
    return handle;
  }

  /**
   * Explicitly replaces an older persisted record with a current-version one.
   * The caller must state the exact source `version`/`schema` it expects and
   * the target schema. Every identity field stored in the record is verified
   * before the callback runs, so a record that does not match the declaration
   * (or is already current) is rejected before any write. `migrate` receives
   * the decoded old value (any shape) and must return the GUI state for
   * {@link STATE_STORAGE_VERSION}. The record is written only after the
   * callback and validation succeed, so a decoding, callback, or validation
   * error leaves the stored value untouched. A store error is not rolled back:
   * if the store partially applied the write before throwing, the record may
   * already mix old and new data. `migrate` never deletes the record (use
   * {@link remove} for that), and {@link acquire} never invokes it
   * automatically.
   *
   * Any released zero-handle entry for the identity is evicted before the
   * callback runs. A failed migration therefore cannot leave an old in-memory
   * state that a later `acquire` reuses to overwrite the persisted record; the
   * next acquisition reloads from the store.
   *
   * While the callback and the write run, this identity is locked: a reentrant
   * `acquire` or `migrate` for it throws a `LIVE_STATE`
   * {@link StateConflictError}, so the callback cannot register a lease that
   * survives the migration and later writes the old schema back. The lock is
   * cleared even when the callback throws, and other identities are unaffected.
   *
   * Call before acquiring, or after releasing every handle. A live state, or a
   * non-persistent registration on the same identity, blocks migration.
   */
  migrate(options: StateMigrationOptions, migrate: StateMigration): void {
    const normalized = normalizeMigrationOptions(options);
    if (typeof migrate !== "function") {
      throw new StateValidationError("migrate must be a function");
    }
    if (this.#store === undefined) {
      throw new StateValidationError(
        "migration requires an injected state store",
      );
    }
    const identity = identityOf(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );
    if (this.#mutating.has(identity)) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} is already being migrated or removed`,
      );
    }
    const entry = this.#entries.get(identity);
    if (
      entry !== undefined &&
      (entry.handles.size > 0 || entry.lifetime !== "persistent")
    ) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} is still in use; release it before migrating`,
      );
    }
    // Evict the released entry before touching the record. If anything below
    // throws (including a partially applied store write), a later acquire must
    // reload from the store instead of reusing this entry's stale state and
    // writing it back over the record.
    if (entry !== undefined) {
      this.#entries.delete(identity);
    }

    this.#mutating.add(identity);
    try {
      const stored = this.#readStoredObject(identity);
      if (stored === null) {
        throw new StateConflictError(
          "MISSING_STATE",
          `No persisted state exists for ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)}`,
        );
      }
      const legacy = stored.parsed;
      this.#assertMigrationSource(identity, legacy, normalized);

      const guiState = cloneState(migrate(legacy), "migrated.guiState");
      const record: StoredGuiState = {
        version: STATE_STORAGE_VERSION,
        scope: normalized.scope,
        key: normalized.key,
        ...(normalized.ownerId === undefined
          ? {}
          : { ownerId: normalized.ownerId }),
        lifetime: "persistent",
        schema: normalized.schema,
        guiState,
      };
      this.#store.setItem(storageKeyOf(identity), JSON.stringify(record));
    } finally {
      this.#mutating.delete(identity);
    }
  }

  /**
   * Deletes the persisted record for an identity. This is the supported escape
   * hatch for a record that {@link acquire} rejects as corrupt or for an
   * incompatible schema; without it a caller has to reach into the injected
   * store and reproduce {@link storageKeyOf} by hand.
   *
   * The stored value is not decoded or validated first: removal works on
   * unreadable data. A missing record is not an error, so calling this twice is
   * safe. The identity must not be live: a state with handles, a non-persistent
   * registration, or an identity whose migration/removal is already running is
   * rejected with a `LIVE_STATE` {@link StateConflictError}. Any released
   * zero-handle persistent entry is evicted before the store call; if the store
   * then throws, the record may still be present but the next `acquire` reloads
   * it from the store instead of reusing stale memory.
   *
   * While `store.removeItem` runs, this identity is locked like a running
   * {@link migrate}: a reentrant `acquire`, `migrate`, or `remove` for it throws
   * a `LIVE_STATE` {@link StateConflictError}, so the injected store cannot
   * register a fresh lease and have its record (or its write) deleted by the
   * removal in progress. The lock is cleared even when the store throws, and
   * other identities are unaffected.
   *
   * A store error is not rolled back: a store that deleted the record and then
   * threw leaves it gone even though `remove` throws, so the caller cannot tell
   * "not removed" from "removed, error reported" by the exception alone. The
   * in-memory entry is evicted either way, so memory never resurrects a value
   * the store rejected.
   */
  remove(options: StateRemoveOptions): void {
    const normalized = normalizeRemoveOptions(options);
    const store = this.#store;
    if (store === undefined) {
      throw new StateValidationError(
        "removal requires an injected state store",
      );
    }
    const identity = identityOf(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );
    if (this.#mutating.has(identity)) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} is being migrated or removed; remove it after the operation settles`,
      );
    }
    const entry = this.#entries.get(identity);
    if (
      entry !== undefined &&
      (entry.handles.size > 0 || entry.lifetime !== "persistent")
    ) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} is still in use; release it before removing`,
      );
    }
    this.#mutating.add(identity);
    try {
      if (entry !== undefined) {
        this.#entries.delete(identity);
      }
      store.removeItem(storageKeyOf(identity));
    } finally {
      this.#mutating.delete(identity);
    }
  }

  /** Convenience wrapper for {@link StateHandle.release}. */
  release(handle: StateHandle): void {
    requireInternals(handle, this);
    handle.release();
  }

  #assertCompatible(
    entry: StateEntry,
    normalized: NormalizedAcquireOptions,
  ): void {
    if (entry.schema !== normalized.schema) {
      throw new StateConflictError(
        "SCHEMA_MISMATCH",
        `State ${describeIdentity(entry.scope, entry.ownerId, entry.key)} was registered with schema "${entry.schema}", not "${normalized.schema}"`,
      );
    }
    if (entry.lifetime !== normalized.lifetime) {
      throw new StateConflictError(
        "LIFETIME_MISMATCH",
        `State ${describeIdentity(entry.scope, entry.ownerId, entry.key)} was registered with lifetime "${entry.lifetime}", not "${normalized.lifetime}"`,
      );
    }
  }

  /**
   * Commits a patch for a live handle owned by this manager. The handle is
   * resolved through the private table, so a forged handle/entry cannot reach
   * a state identity, and the patch is validated before any commit.
   */
  _set(handle: StateHandle, patch: unknown): StateSnapshot {
    const internals = requireInternals(handle, this);
    const entry = internals.entry;
    if (!internals.active) {
      throw new StateReleasedError("State handle has been released");
    }
    if (entry.released) {
      throw new StateReleasedError("State has been released");
    }
    if (this.#mutating.has(entry.identity)) {
      throw new StateConflictError(
        "LIVE_STATE",
        `State ${describeIdentity(entry.scope, entry.ownerId, entry.key)} is being written to its store; set it after the write settles`,
      );
    }
    const validated = cloneState(patch, "patch");
    const merged = mergeState(entry.state, validated);
    if (merged.changed.length === 0) {
      return entry.state;
    }
    if (entry.lifetime === "persistent") {
      // Lock the identity across the write. A store hook can otherwise acquire
      // the live entry and commit nested state; this commit would then overwrite
      // that state in memory (and its record) without telling anyone.
      this.#mutating.add(entry.identity);
      try {
        this.#savePersistent(entry.identity, entry, merged.state);
      } finally {
        this.#mutating.delete(entry.identity);
      }
    }
    entry.state = merged.state;
    const generation = (entry.generation += 1);
    const root = entry.notification === undefined;
    const pass: NotificationPass = entry.notification ?? {
      changed: [],
      delivered: new Map(),
    };
    entry.notification = pass;
    for (const field of merged.changed) {
      if (!pass.changed.includes(field)) {
        pass.changed.push(field);
      }
    }
    try {
      for (const target of [...entry.handles]) {
        this._notify(target, merged.state, merged.changed, generation, pass);
      }
    } finally {
      if (root) {
        entry.notification = undefined;
      }
    }
    return merged.state;
  }

  _enqueue<T>(
    handle: StateHandle,
    task: () => T | Promise<T>,
  ): Promise<T> {
    const internals = requireInternals(handle, this);
    const entry = internals.entry;
    if (!internals.active || entry.released) {
      return Promise.reject(
        new StateReleasedError("Cannot enqueue work for a released state"),
      );
    }
    const run = entry.tail.then(() => {
      if (!internals.active || entry.released) {
        throw new StateReleasedError(
          "Queued work was discarded because the state was released",
        );
      }
      return task();
    });
    entry.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  _update(
    handle: StateHandle,
    updater: (
      state: StateSnapshot,
    ) => GuiStatePatch | Promise<GuiStatePatch>,
  ): Promise<StateSnapshot> {
    return this._enqueue(handle, async () => {
      const internals = requireInternals(handle, this);
      const entry = internals.entry;
      const base = entry.state;
      const patch = await updater(base);
      if (!internals.active || entry.released) {
        throw new StateReleasedError(
          "Async update was discarded because the state was released",
        );
      }
      if (entry.state !== base) {
        throw new StateConflictError(
          "STALE_STATE",
          "State changed while the async updater was running; the update was not applied",
        );
      }
      return this._set(handle, patch);
    });
  }

  _release(handle: StateHandle): void {
    const internals = requireInternals(handle, this);
    if (!internals.active) {
      return;
    }
    internals.active = false;
    internals.listeners.clear();
    const entry = internals.entry;
    entry.handles.delete(handle as StateHandleImpl);
    if (entry.handles.size > 0) {
      return;
    }
    if (entry.lifetime === "window") {
      entry.released = true;
      entry.state = EMPTY_STATE;
      this.#entries.delete(entry.identity);
    }
    // `session` and `persistent` entries stay registered with zero handles so
    // a later Window starts from the latest value.
  }

  _notify(
    handle: StateHandle,
    state: StateSnapshot,
    changed: readonly GuiStateField[],
    generation: number,
    pass: NotificationPass,
  ): void {
    const internals = requireInternals(handle, this);
    // Iterate a snapshot so listeners removed (or released) by an earlier
    // listener during this pass still receive the change that was committed.
    for (const listener of [...internals.listeners]) {
      // A listener may commit a newer state reentrantly (directly or through a
      // listener on another handle). That commit already notified every
      // subscriber, so delivering this older `state` afterwards would leave
      // them with a stale snapshot as their last notification.
      if (internals.entry.generation !== generation) {
        return;
      }
      // A listener that has not received any commit in this cascade missed the
      // superseded changes, so it gets their union; one already notified gets
      // only what this commit changed. Tracked per registration: the same
      // function on another handle has its own notification state.
      let deliveredTo = pass.delivered.get(handle);
      if (deliveredTo === undefined) {
        deliveredTo = new Set();
        pass.delivered.set(handle, deliveredTo);
      }
      const delivered = deliveredTo.has(listener)
        ? changed
        : Object.freeze([...pass.changed]);
      deliveredTo.add(listener);
      try {
        listener(state, delivered);
      } catch (error) {
        this._reportError(error);
      }
    }
  }

  _reportError(error: unknown): void {
    if (this.#onError === undefined) {
      return;
    }
    try {
      this.#onError(error);
    } catch {
      // An error reporter must not break state processing.
    }
  }

  /**
   * Rejects a stored record whose version, schema, identity, or lifetime does
   * not match what the caller declared, before the callback or any write.
   * Missing `schema`/`lifetime` are the design 9.6 shape: schema-less and
   * persistent.
   */
  #assertMigrationSource(
    identity: string,
    record: Record<string, unknown>,
    normalized: NormalizedMigrationOptions,
  ): void {
    const source = describeIdentity(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );
    if (record.version !== normalized.fromVersion) {
      throw new StateConflictError(
        "VERSION_MISMATCH",
        `Stored state ${source} has version ${String(record.version)}; migration expects ${normalized.fromVersion}`,
      );
    }
    const storedSchema = storedSchemaOf(record);
    if (storedSchema !== normalized.fromSchema) {
      throw new StateConflictError(
        "SCHEMA_MISMATCH",
        `Stored state ${source} has schema ${JSON.stringify(storedSchema)}; migration expects ${JSON.stringify(normalized.fromSchema)}`,
      );
    }
    if (
      record.scope !== normalized.scope ||
      record.key !== normalized.key ||
      (record.ownerId ?? undefined) !== normalized.ownerId
    ) {
      throw new StateConflictError(
        "IDENTITY_MISMATCH",
        `Stored state under ${storageKeyOf(identity)} describes a different identity than ${source}`,
      );
    }
    const storedLifetime = storedLifetimeOf(record);
    if (storedLifetime !== "persistent") {
      throw new StateConflictError(
        "LIFETIME_MISMATCH",
        `Stored state ${source} has lifetime ${JSON.stringify(storedLifetime)}; migration only rewrites persistent records`,
      );
    }
  }

  #savePersistent(
    identity: string,
    entry: Pick<
      StateEntry,
      "scope" | "key" | "ownerId" | "lifetime" | "schema"
    >,
    state: StateSnapshot,
  ): void {
    if (this.#store === undefined) {
      throw new StateValidationError(
        "persistent lifetime requires an injected state store",
      );
    }
    const record: StoredGuiState = {
      version: STATE_STORAGE_VERSION,
      scope: entry.scope,
      key: entry.key,
      ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
      lifetime: entry.lifetime,
      schema: entry.schema,
      guiState: state,
    };
    this.#store.setItem(
      storageKeyOf(identity),
      JSON.stringify(record),
    );
  }

  /**
   * Reads and decodes the record at `identity` without interpreting its
   * version or schema. Returns `null` when no record exists. Malformed data
   * throws {@link StateCorruptionError} and is never modified, unless
   * `recover` is true, in which case the record is quarantined and `null` is
   * returned. The raw value is returned next to the decoded object so a
   * quarantine backs up exactly the bytes that failed to decode.
   */
  #readStoredObject(
    identity: string,
    recover = false,
  ): StoredRead | null {
    const store = this.#store;
    if (store === undefined) {
      return null;
    }
    const raw = store.getItem(storageKeyOf(identity));
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw !== "string") {
      return this.#corrupt(
        identity,
        raw,
        "stored value is not a string",
        recover,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.#corrupt(
        identity,
        raw,
        "stored value is not valid JSON",
        recover,
      );
    }
    if (!isPlainObject(parsed)) {
      return this.#corrupt(
        identity,
        raw,
        "stored value is not a JSON object",
        recover,
      );
    }
    return { raw, parsed };
  }

  /**
   * Apply a declared automatic migration to an otherwise rejected record.
   * The caller holds the identity lock. Returns `null` when no declared
   * migration matches, so the normal fail-closed path reports the mismatch.
   *
   * The record is rewritten only after the callback result passes state
   * validation; a throwing or invalid callback leaves the old record in place.
   */
  #autoMigrate(
    normalized: NormalizedAcquireOptions,
    identity: string,
    parsed: Record<string, unknown>,
  ): StateSnapshot | null {
    const store = this.#store;
    if (store === undefined || normalized.lifetime !== "persistent") {
      return null;
    }
    if (
      parsed.scope !== normalized.scope ||
      parsed.key !== normalized.key ||
      (parsed.ownerId ?? undefined) !== normalized.ownerId
    ) {
      return null;
    }
    // The manual `migrate` contract also treats a record without a lifetime
    // as an older persistent record (design 9.6 predates the field).
    if (storedLifetimeOf(parsed) !== "persistent") {
      return null;
    }
    const storedSchema = storedSchemaOf(parsed);
    const migration = this.#migrations.find(
      (candidate) =>
        candidate.identity === identity &&
        candidate.fromVersion === parsed.version &&
        candidate.fromSchema === storedSchema &&
        candidate.schema === normalized.schema,
    );
    if (migration === undefined) {
      return null;
    }

    const guiState = cloneState(migration.migrate(parsed), "migrated.guiState");
    const record: StoredGuiState = {
      version: STATE_STORAGE_VERSION,
      scope: normalized.scope,
      key: normalized.key,
      ...(normalized.ownerId === undefined
        ? {}
        : { ownerId: normalized.ownerId }),
      lifetime: "persistent",
      schema: normalized.schema,
      guiState,
    };
    store.setItem(storageKeyOf(identity), JSON.stringify(record));
    return guiState;
  }

  #loadPersistent(
    normalized: NormalizedAcquireOptions,
    identity: string,
  ): StateSnapshot | null {
    if (this.#store === undefined) {
      return null;
    }
    const stored = this.#readStoredObject(identity, this.#quarantineCorrupt);
    if (stored === null) {
      return null;
    }
    const parsed = stored.parsed;

    if (parsed.version !== STATE_STORAGE_VERSION) {
      const migrated = this.#autoMigrate(normalized, identity, parsed);
      if (migrated !== null) {
        return migrated;
      }
      throw new StateConflictError(
        "VERSION_MISMATCH",
        `Stored state ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} has version ${String(parsed.version)}; expected ${STATE_STORAGE_VERSION}`,
      );
    }
    if (
      parsed.scope !== normalized.scope ||
      parsed.key !== normalized.key ||
      (parsed.ownerId ?? undefined) !== normalized.ownerId
    ) {
      throw new StateConflictError(
        "IDENTITY_MISMATCH",
        `Stored state under ${storageKeyOf(identity)} describes a different identity`,
      );
    }
    // Design 9.6 records have neither `lifetime` nor `schema`. They are read
    // as persistent and schema-less, the same way `migrate` reads them, so a
    // declared migration can upgrade a record that happens to carry the
    // current storage version. Explicitly tagged non-persistent records still
    // fail closed without being touched.
    const storedLifetime = storedLifetimeOf(parsed);
    if (storedLifetime !== normalized.lifetime) {
      throw new StateConflictError(
        "LIFETIME_MISMATCH",
        `Stored state ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} has lifetime ${JSON.stringify(storedLifetime)}, not "${normalized.lifetime}"`,
      );
    }
    const storedSchema = storedSchemaOf(parsed);
    if (storedSchema !== normalized.schema) {
      const migrated = this.#autoMigrate(normalized, identity, parsed);
      if (migrated !== null) {
        return migrated;
      }
      throw new StateConflictError(
        "SCHEMA_MISMATCH",
        `Stored state ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} has schema ${JSON.stringify(storedSchema)}, not "${normalized.schema}"`,
      );
    }
    if (!hasOwn(parsed, "guiState")) {
      return this.#corrupt(
        identity,
        stored.raw,
        "stored value has no guiState",
        this.#quarantineCorrupt,
      );
    }

    try {
      return cloneState(parsed.guiState, "persisted.guiState");
    } catch (error) {
      return this.#corrupt(
        identity,
        stored.raw,
        `stored guiState is invalid (${error instanceof Error ? error.message : String(error)})`,
        this.#quarantineCorrupt,
      );
    }
  }

  #corrupt(
    identity: string,
    raw: unknown,
    reason: string,
    recover: boolean,
  ): null {
    const error = new StateCorruptionError(
      `Corrupt persisted state ${storageKeyOf(identity)}: ${reason}. ` +
        (recover
          ? "The stored record was quarantined and acquire starts from its initial state."
          : "The stored record was left unchanged; fix or remove it explicitly."),
    );
    if (!recover) {
      throw error;
    }
    // `acquire` holds the identity lock here, so neither a store hook nor the
    // `onError` callback can open a second live entry for this identity while
    // the recovery is half-done.
    this.#quarantine(identity, raw);
    this._reportError(error);
    return null;
  }

  /**
   * Copies the raw record at `identity` to the first free `...:quarantine`
   * key, then removes the original. The caller holds the identity lock.
   *
   * Quarantine keys are prefixed with the record's own storage key, which is
   * `invui:gui-state:<JSON identity>` and therefore always ends in `]`. A
   * normal storage key can never equal `<base>:quarantine` (that suffix is not
   * part of a JSON identity), so a backup never shadows another record; the
   * bounded slot scan below stays inside the same namespace.
   *
   * The copy is written before the removal, and the removal re-checks that the
   * value is still the one that failed to decode, so a failing or changing
   * store never destroys un-backed-up data.
   */
  #quarantine(identity: string, raw: unknown): void {
    const store = this.#store;
    if (store === undefined) {
      throw new StateValidationError(
        "quarantineCorrupt requires an injected state store",
      );
    }
    const base = storageKeyOf(identity);
    if (typeof raw !== "string") {
      throw new StateCorruptionError(
        `Corrupt persisted state ${base}: the stored value is not a string, so it cannot be quarantined; it was left unchanged.`,
      );
    }

    for (let index = 1; index <= MAX_QUARANTINE_SLOTS; index += 1) {
      const key =
        index === 1 ? `${base}:quarantine` : `${base}:quarantine:${index}`;
      const existing: unknown = store.getItem(key);
      if (existing !== null && existing !== undefined && existing !== raw) {
        continue;
      }
      // Identical bytes are already backed up, for example when an earlier
      // attempt failed between the copy and the deletion. Reusing that slot
      // keeps retries idempotent instead of filling new slots forever.
      const alreadyBackedUp = existing === raw;
      if (!alreadyBackedUp) {
        store.setItem(key, raw);
      }
      if (store.getItem(base) !== raw) {
        throw new StateCorruptionError(
          `Corrupt persisted state ${base} changed while it was being quarantined; the stored record was left in place` +
            (alreadyBackedUp ? "." : ` (backup at ${key}).`),
        );
      }
      store.removeItem(base);
      return;
    }
    throw new StateCorruptionError(
      `Corrupt persisted state ${base}: no free quarantine key within ${MAX_QUARANTINE_SLOTS} slots; the stored record was left unchanged.`,
    );
  }
}

/**
 * Public handle. It deliberately owns no reachable fields: all mutable state
 * lives in {@link HANDLE_INTERNALS}, so callers cannot read or replace the
 * internal entry (`handle.entry`, `handle.manager`, etc. are undefined).
 */
class StateHandleImpl implements StateHandle {
  constructor(manager: StateManager, entry: StateEntry) {
    HANDLE_INTERNALS.set(this, {
      manager,
      entry,
      active: true,
      listeners: new Set(),
    });
  }

  get scope(): StateScope {
    return internalsOf(this).entry.scope;
  }

  get key(): string {
    return internalsOf(this).entry.key;
  }

  get lifetime(): StateLifetime {
    return internalsOf(this).entry.lifetime;
  }

  get ownerId(): string | undefined {
    return internalsOf(this).entry.ownerId;
  }

  get schema(): string {
    return internalsOf(this).entry.schema;
  }

  get released(): boolean {
    return !internalsOf(this).active;
  }

  get(): StateSnapshot {
    const internals = this.#requireActive();
    return internals.entry.state;
  }

  set(patch: GuiStatePatch): StateSnapshot {
    const internals = this.#requireActive();
    return internals.manager._set(this, patch);
  }

  subscribe(listener: StateListener): StateUnsubscribe {
    const internals = this.#requireActive();
    if (typeof listener !== "function") {
      throw new StateValidationError("listener must be a function");
    }
    internals.listeners.add(listener);
    return () => {
      internals.listeners.delete(listener);
    };
  }

  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const internals = this.#requireActive();
    if (typeof task !== "function") {
      throw new StateValidationError("task must be a function");
    }
    return internals.manager._enqueue(this, task);
  }

  update(
    updater: (
      state: StateSnapshot,
    ) => GuiStatePatch | Promise<GuiStatePatch>,
  ): Promise<StateSnapshot> {
    const internals = this.#requireActive();
    if (typeof updater !== "function") {
      throw new StateValidationError("updater must be a function");
    }
    return internals.manager._update(this, updater);
  }

  release(): void {
    internalsOf(this).manager._release(this);
  }

  #requireActive(): HandleInternals {
    const internals = internalsOf(this);
    if (!internals.active || internals.entry.released) {
      throw new StateReleasedError(
        `State ${describeIdentity(internals.entry.scope, internals.entry.ownerId, internals.entry.key)} has been released`,
      );
    }
    return internals;
  }
}
