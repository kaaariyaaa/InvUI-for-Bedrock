/**
 * GUI state management (design chapters 9 and 12).
 *
 * This module is intentionally independent from the Bedrock Script API. All
 * persistence is delegated to an injected synchronous string store, which keeps
 * the state machine testable outside Minecraft.
 */

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
 * and no state is committed.
 */
export interface StateStore {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StateManagerOptions {
  /**
   * Receives isolated errors that must not break state processing, such as a
   * subscriber throwing. Corrupt persisted data is surfaced as a
   * {@link StateCorruptionError} from `acquire` instead.
   */
  onError?: (error: unknown) => void;
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
   */
  set(patch: GuiStatePatch): StateSnapshot;

  subscribe(listener: StateListener): StateUnsubscribe;

  /**
   * Queue work against this handle's state identity. Tasks for the same name
   * run strictly one after another; tasks for different identities may overlap.
   * Queued tasks are rejected with {@link StateReleasedError} if this handle
   * (or a `window`-lifetime state) is released before they start.
   */
  enqueue<T>(task: () => T | Promise<T>): Promise<T>;

  /**
   * Atomic read-modify-write inside the same identity queue. The updater
   * receives the snapshot at execution time; its result is validated and
   * committed via {@link StateHandle.set}. If the state changed while an async
   * updater was running, or the handle was released, nothing is written.
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
      | "STALE_STATE",
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
 * Persisted data could not be decoded. The stored record is left untouched and
 * acquisition fails closed so the next write cannot destroy recoverable data.
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
const MANAGER_KEYS = new Set(["onError"]);
const EMPTY_STATE: StateSnapshot = Object.freeze({});
const EMPTY_CHANGED: readonly GuiStateField[] = Object.freeze([]);
const MAX_JSON_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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
 * Validates, deep-clones, and deep-freezes a JSON value. Only plain objects,
 * arrays, strings, finite numbers, booleans, and null are accepted.
 */
function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new StateValidationError(`${path} is nested too deeply`);
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
      throw new StateValidationError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new StateValidationError(
      `${path} contains a non-JSON value (${typeof value})`,
    );
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new StateValidationError(`${path} contains a circular reference`);
  }
  ancestors.add(object);

  let cloned: unknown;
  if (Array.isArray(object)) {
    const array: unknown[] = [];
    for (let index = 0; index < object.length; index += 1) {
      if (!(index in object)) {
        throw new StateValidationError(`${path} contains a sparse array`);
      }
      array.push(
        cloneJsonValue(object[index], `${path}[${index}]`, ancestors, depth + 1),
      );
    }
    cloned = Object.freeze(array);
  } else {
    if (!isPlainObject(object)) {
      throw new StateValidationError(
        `${path} must contain only plain objects and arrays`,
      );
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new StateValidationError(`${path} contains symbol keys`);
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new StateValidationError(`${path}.${key} must be a data property`);
      }
      if (
        descriptor.value === undefined ||
        typeof descriptor.value === "function" ||
        typeof descriptor.value === "symbol" ||
        typeof descriptor.value === "bigint"
      ) {
        throw new StateValidationError(
          `${path}.${key} contains a non-JSON value`,
        );
      }
      Object.defineProperty(record, key, {
        value: cloneJsonValue(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
          depth + 1,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    cloned = Object.freeze(record);
  }

  ancestors.delete(object);
  return cloned;
}

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
    state.data = cloneJsonValue(input.data, `${label}.data`, new Set(), 0);
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

function normalizeAcquireOptions(input: unknown): NormalizedAcquireOptions {
  if (!isPlainObject(input)) {
    throw new StateValidationError("acquire options must be a plain object");
  }
  for (const key of Object.keys(input)) {
    if (!ACQUIRE_KEYS.has(key)) {
      throw new StateValidationError(`unknown acquire option "${key}"`);
    }
  }

  const scope = input.scope ?? "player";
  if (scope !== "player" && scope !== "shared") {
    throw new StateValidationError(
      'scope must be "player" or "shared"',
    );
  }

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

  const schema =
    input.schema === undefined
      ? "default"
      : requireNonEmptyString(input.schema, "schema");

  const initial =
    input.initial === undefined
      ? EMPTY_STATE
      : cloneState(input.initial, "initial");

  return { scope, key, ownerId, lifetime, schema, initial };
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
  released: boolean;
}

/**
 * Owns state identities, leases, subscriptions, persistence, and per-identity
 * async ordering. One instance is expected per script generation.
 */
export class StateManager {
  readonly #store: StateStore | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #entries = new Map<string, StateEntry>();

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

    this.#store = store ?? undefined;
    this.#onError = options.onError;
  }

  /**
   * Registers a Window's interest in a state identity and returns its lease.
   * The state starts from the live value, then persisted data, then `initial`.
   */
  acquire(options: StateAcquireOptions): StateHandle {
    const optionsInput: unknown = options;
    const normalized = normalizeAcquireOptions(optionsInput);
    const identity = identityOf(
      normalized.scope,
      normalized.ownerId,
      normalized.key,
    );

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
      // Peek even for non-persistent lifetimes so a stored persistent record
      // under the same key is rejected as a lifetime/schema conflict instead of
      // silently coexisting with a new in-memory state.
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
      released: false,
    };
    this.#entries.set(identity, entry);

    const handle = new StateHandleImpl(this, entry);
    entry.handles.add(handle);
    return handle;
  }

  /** Convenience wrapper for {@link StateHandle.release}. */
  release(handle: StateHandle): void {
    if (!(handle instanceof StateHandleImpl) || handle.manager !== this) {
      throw new StateValidationError(
        "handle was not created by this StateManager",
      );
    }
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
   * Commits a patch. The patch is validated here so no call path (including a
   * direct `_set(handle.entry, ...)`) can commit unvalidated state. Store
   * errors abort the commit.
   */
  _set(entry: StateEntry, patch: unknown): StateSnapshot {
    if (entry.released) {
      throw new StateReleasedError("State has been released");
    }
    const validated = cloneState(patch, "patch");
    const merged = mergeState(entry.state, validated);
    if (merged.changed.length === 0) {
      return entry.state;
    }
    if (entry.lifetime === "persistent") {
      this.#savePersistent(entry.identity, entry, merged.state);
    }
    entry.state = merged.state;
    for (const handle of [...entry.handles]) {
      handle._notify(merged.state, merged.changed);
    }
    return merged.state;
  }

  _enqueue<T>(
    handle: StateHandleImpl,
    task: () => T | Promise<T>,
  ): Promise<T> {
    const entry = handle.entry;
    if (!handle.active || entry.released) {
      return Promise.reject(
        new StateReleasedError("Cannot enqueue work for a released state"),
      );
    }
    const run = entry.tail.then(() => {
      if (!handle.active || entry.released) {
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
    handle: StateHandleImpl,
    updater: (
      state: StateSnapshot,
    ) => GuiStatePatch | Promise<GuiStatePatch>,
  ): Promise<StateSnapshot> {
    return this._enqueue(handle, async () => {
      const entry = handle.entry;
      const base = entry.state;
      const patch = await updater(base);
      if (!handle.active || entry.released) {
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
      return this._set(entry, patch);
    });
  }

  _release(handle: StateHandleImpl): void {
    if (!handle.active) {
      return;
    }
    handle._deactivate();
    const entry = handle.entry;
    entry.handles.delete(handle);
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

  #loadPersistent(
    normalized: NormalizedAcquireOptions,
    identity: string,
  ): StateSnapshot | null {
    const store = this.#store;
    if (store === undefined) {
      return null;
    }
    const raw = store.getItem(storageKeyOf(identity));
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw !== "string") {
      this.#corrupt(identity, "stored value is not a string");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#corrupt(identity, "stored value is not valid JSON");
    }
    if (!isPlainObject(parsed)) {
      this.#corrupt(identity, "stored value is not a JSON object");
    }

    if (parsed.version !== STATE_STORAGE_VERSION) {
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
    if (parsed.lifetime !== normalized.lifetime) {
      throw new StateConflictError(
        "LIFETIME_MISMATCH",
        `Stored state ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} has lifetime "${String(parsed.lifetime)}", not "${normalized.lifetime}"`,
      );
    }
    if (parsed.schema !== normalized.schema) {
      throw new StateConflictError(
        "SCHEMA_MISMATCH",
        `Stored state ${describeIdentity(normalized.scope, normalized.ownerId, normalized.key)} has schema "${String(parsed.schema)}", not "${normalized.schema}"`,
      );
    }
    if (!hasOwn(parsed, "guiState")) {
      this.#corrupt(identity, "stored value has no guiState");
    }

    try {
      return cloneState(parsed.guiState, "persisted.guiState");
    } catch (error) {
      this.#corrupt(
        identity,
        `stored guiState is invalid (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  #corrupt(identity: string, reason: string): never {
    throw new StateCorruptionError(
      `Corrupt persisted state ${storageKeyOf(identity)}: ${reason}. ` +
        "The stored record was left unchanged; fix or remove it explicitly.",
    );
  }
}

class StateHandleImpl implements StateHandle {
  readonly #manager: StateManager;
  readonly #entry: StateEntry;
  readonly #listeners = new Set<StateListener>();
  #active = true;

  constructor(manager: StateManager, entry: StateEntry) {
    this.#manager = manager;
    this.#entry = entry;
  }

  get manager(): StateManager {
    return this.#manager;
  }

  get entry(): StateEntry {
    return this.#entry;
  }

  get active(): boolean {
    return this.#active;
  }

  get scope(): StateScope {
    return this.#entry.scope;
  }

  get key(): string {
    return this.#entry.key;
  }

  get lifetime(): StateLifetime {
    return this.#entry.lifetime;
  }

  get ownerId(): string | undefined {
    return this.#entry.ownerId;
  }

  get schema(): string {
    return this.#entry.schema;
  }

  get released(): boolean {
    return !this.#active;
  }

  get(): StateSnapshot {
    this.#assertActive();
    return this.#entry.state;
  }

  set(patch: GuiStatePatch): StateSnapshot {
    this.#assertActive();
    return this.#manager._set(this.#entry, patch);
  }

  subscribe(listener: StateListener): StateUnsubscribe {
    this.#assertActive();
    if (typeof listener !== "function") {
      throw new StateValidationError("listener must be a function");
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    this.#assertActive();
    if (typeof task !== "function") {
      throw new StateValidationError("task must be a function");
    }
    return this.#manager._enqueue(this, task);
  }

  update(
    updater: (
      state: StateSnapshot,
    ) => GuiStatePatch | Promise<GuiStatePatch>,
  ): Promise<StateSnapshot> {
    this.#assertActive();
    if (typeof updater !== "function") {
      throw new StateValidationError("updater must be a function");
    }
    return this.#manager._update(this, updater);
  }

  release(): void {
    this.#manager._release(this);
  }

  _deactivate(): void {
    this.#active = false;
    this.#listeners.clear();
  }

  _notify(
    state: StateSnapshot,
    changed: readonly GuiStateField[],
  ): void {
    // Iterate a snapshot so listeners removed (or released) by an earlier
    // listener during this pass still receive the change that was committed.
    for (const listener of [...this.#listeners]) {
      try {
        listener(state, changed);
      } catch (error) {
        this.#manager._reportError(error);
      }
    }
  }

  #assertActive(): void {
    if (!this.#active || this.#entry.released) {
      throw new StateReleasedError(
        `State ${describeIdentity(this.#entry.scope, this.#entry.ownerId, this.#entry.key)} has been released`,
      );
    }
  }
}
