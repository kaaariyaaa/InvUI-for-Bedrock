/** GUI state manager and lease lifecycle. */
import type { GuiStatePatch, GuiStateField, StateSnapshot, StateScope, StateLifetime, StateAcquireOptions, StateMigrationOptions, StateRemoveOptions, StateManagerOptions, StateStore, StoredGuiState, StateHandle, StateListener, StateUnsubscribe, StateMigration } from "./state-types.js";
import { StateValidationError, StateConflictError, StateCorruptionError, StateReleasedError, STATE_STORAGE_VERSION } from "./state-types.js";
import { MANAGER_KEYS, EMPTY_STATE, MAX_QUARANTINE_SLOTS, cloneState, mergeState, normalizeAcquireOptions, normalizeRemoveOptions, normalizeMigrationOptions, normalizeAutoMigrations, identityOf, storageKeyOf, storedLifetimeOf, storedSchemaOf, describeIdentity } from "./state-helpers.js";
import type { NormalizedAcquireOptions, StoredRead, NormalizedMigrationOptions, NormalizedAutoMigration } from "./state-helpers.js";

export * from "./state-types.js";

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
   * Lock an identity during persistence, migration, and recovery to reject
   * reentrant changes.
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
   * Acquire from existing state, stored values, or initial state.
   * Initial persistent values are stored before the handle is returned.
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
   * Migrate only when the record's identity, schema, and version match.
   * Validate the result before writing; store writes are not rolled back.
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
      this.#writeRecord(identity, record);
    } finally {
      this.#mutating.delete(identity);
    }
  }

  /**
   * Remove stored records, including corrupt data, only when no state
   * handle is active. Missing records are allowed.
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

  /**
   * Deliver a state error to the configured reporter, or to the log when none
   * is configured (design 14.1: never swallow an error, notify a handler or
   * log it). A throwing reporter is logged with the original error, and does
   * not break state processing.
   */
  _reportError(error: unknown): void {
    if (this.#onError === undefined) {
      console.error("InvUI: state error.", error);
      return;
    }
    try {
      this.#onError(error);
    } catch (handlerError) {
      // Keep the original error too: the handler failed before handling it.
      console.error("InvUI: state error handler failed.", handlerError, error);
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
    const record: StoredGuiState = {
      version: STATE_STORAGE_VERSION,
      scope: entry.scope,
      key: entry.key,
      ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
      lifetime: entry.lifetime,
      schema: entry.schema,
      guiState: state,
    };
    this.#writeRecord(identity, record);
  }

  /**
   * Writes one complete persisted record and reports a store failure through
   * the manager's error channel before rethrowing it.
   *
   * The in-memory state has not been committed when this throws, so the last
   * successfully written record stays in the store, survives a reload, and the
   * failed change can be retried once the store recovers. Reporting here keeps
   * a save failure from ending as a bare exception (design 14.2): the
   * configured `onError`, or the log when none is configured, always sees it.
   */
  #writeRecord(identity: string, record: StoredGuiState): void {
    const store = this.#store;
    if (store === undefined) {
      throw new StateValidationError(
        "persistent lifetime requires an injected state store",
      );
    }
    const value = JSON.stringify(record);
    try {
      store.setItem(storageKeyOf(identity), value);
    } catch (error) {
      this._reportError(error);
      throw error;
    }
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
    this.#writeRecord(identity, record);
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
   * Back up the raw record to a free quarantine key before deletion.
   * Recheck that the source value has not changed.
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
