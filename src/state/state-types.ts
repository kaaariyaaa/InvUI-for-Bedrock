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
 * Store methods may throw and are not rolled back.
 * Use atomic writes to keep in-memory and stored state consistent.
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
   * `acquire`. A failed store save is reported here as well, before the
   * original error propagates to the caller (see {@link StateStore}).
   */
  onError?: (error: unknown) => void;
  /**
   * Optionally back up a corrupt persistent record before resetting its state.
   * Disabled by default; copy or removal errors interrupt recovery.
   */
  quarantineCorrupt?: boolean;
  /**
   * Apply declared migrations for exact persistent version/schema matches.
   * Validate migrated values before writing; unmatched records are rejected.
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
   * Persist changes before publishing state or notifying listeners.
   * A failed store write leaves the live state unchanged.
   */
  set(patch: GuiStatePatch): StateSnapshot;

  subscribe(listener: StateListener): StateUnsubscribe;

  /**
   * Run tasks for one identity sequentially; do not await a nested task
   * queued on the same identity. Use update() for read-modify-write.
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
