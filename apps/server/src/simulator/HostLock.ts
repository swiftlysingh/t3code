/**
 * Host-wide, exact-UDID Simulator ownership.
 *
 * A T3 server may have more than one environment (and more than one
 * worktree) on the same Mac.  The in-memory lease manager therefore cannot
 * be the authority for CoreSimulator ownership.  This module uses one
 * directory per UDID in the user's OS temporary directory. `mkdir` is the
 * exclusive-create operation; the directory is the lock, and owner.json is
 * its ownership metadata (the owner token is not a security token and is
 * never included in contention errors).
 *
 * The implementation intentionally fails closed. A stale lock may only be
 * reclaimed when the recorded PID is provably absent or its process-start
 * identity is provably different. An unknown process identity is never
 * treated as stale, and no process is ever signalled by this module.
 */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  SimulatorLeaseId,
  SimulatorUdid,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";
import * as FileSystem from "node:fs/promises";
import * as OperatingSystem from "node:os";
import * as Path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCK_DIRECTORY_PREFIX = "t3-code-simulator-locks";
const LOCK_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const OWNER_FILE_NAME = "owner.json";
const MAX_RECLAIM_ATTEMPTS = 4;

export const SimulatorHostLockMetadata = Schema.Struct({
  version: Schema.Literal(1),
  udid: SimulatorUdid,
  ownerToken: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  leaseId: SimulatorLeaseId,
  generation: PositiveInt,
  pid: PositiveInt,
  processStartIdentity: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  acquiredAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SimulatorHostLockMetadata = typeof SimulatorHostLockMetadata.Type;

export interface SimulatorHostLockInput {
  readonly udid: SimulatorUdid;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly leaseId: SimulatorLeaseId;
  readonly generation: number;
}

export interface SimulatorHostLockLease {
  readonly path: string;
  readonly metadata: SimulatorHostLockMetadata;
}

export type SimulatorHostProcessState = "alive" | "dead" | "identity-mismatch" | "unknown";

export interface SimulatorHostProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface SimulatorHostLockFileSystem {
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => Promise<void>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly writeFile: (
    path: string,
    data: string,
    options?: { readonly encoding?: "utf8"; readonly mode?: number; readonly flag?: string },
  ) => Promise<void>;
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface SimulatorHostLockProcess {
  readonly current: () => Promise<SimulatorHostProcessIdentity>;
  readonly inspect: (identity: SimulatorHostProcessIdentity) => Promise<SimulatorHostProcessState>;
}

export interface SimulatorHostLockOptions {
  /** Override in tests. The default is shared by all T3 worktrees for a user. */
  readonly rootDirectory?: string;
  readonly fileSystem?: SimulatorHostLockFileSystem;
  readonly process?: SimulatorHostLockProcess;
  readonly now?: () => Date;
  readonly randomToken?: () => string;
}

export class SimulatorHostLockContendedError extends Schema.TaggedErrorClass<SimulatorHostLockContendedError>()(
  "SimulatorHostLockContendedError",
  {
    udid: SimulatorUdid,
    path: TrimmedNonEmptyString,
    ownerEnvironmentId: EnvironmentId,
    ownerThreadId: ThreadId,
    ownerLeaseId: SimulatorLeaseId,
    ownerPid: PositiveInt,
    ownerProcessStartIdentity: TrimmedNonEmptyString,
    acquiredAt: IsoDateTime,
  },
) {
  override get message(): string {
    return `Simulator ${this.udid} is already locked by another T3 process.`;
  }
}

export class SimulatorHostLockUnknownOwnerError extends Schema.TaggedErrorClass<SimulatorHostLockUnknownOwnerError>()(
  "SimulatorHostLockUnknownOwnerError",
  {
    udid: SimulatorUdid,
    path: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator ${this.udid} has a lock whose owner cannot be verified safely.`;
  }
}

export class SimulatorHostLockReleaseMismatchError extends Schema.TaggedErrorClass<SimulatorHostLockReleaseMismatchError>()(
  "SimulatorHostLockReleaseMismatchError",
  {
    udid: SimulatorUdid,
    path: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator ${this.udid} lock ownership no longer matches this lease.`;
  }
}

export class SimulatorHostLockFileSystemError extends Schema.TaggedErrorClass<SimulatorHostLockFileSystemError>()(
  "SimulatorHostLockFileSystemError",
  {
    udid: SimulatorUdid,
    path: TrimmedNonEmptyString,
    operation: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator lock filesystem operation failed (${this.operation}).`;
  }
}

export class SimulatorHostLockCorruptError extends Schema.TaggedErrorClass<SimulatorHostLockCorruptError>()(
  "SimulatorHostLockCorruptError",
  {
    udid: SimulatorUdid,
    path: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator ${this.udid} has invalid lock metadata.`;
  }
}

export type SimulatorHostLockError =
  | SimulatorHostLockContendedError
  | SimulatorHostLockUnknownOwnerError
  | SimulatorHostLockReleaseMismatchError
  | SimulatorHostLockFileSystemError
  | SimulatorHostLockCorruptError;

const defaultFileSystem: SimulatorHostLockFileSystem = {
  mkdir: async (path, options) => {
    await FileSystem.mkdir(path, options);
  },
  readFile: async (path, encoding) => FileSystem.readFile(path, encoding),
  writeFile: async (path, data, options) => {
    await FileSystem.writeFile(path, data, options);
  },
  readdir: async (path) => FileSystem.readdir(path),
  rename: async (from, to) => {
    await FileSystem.rename(from, to);
  },
  rmdir: async (path) => {
    await FileSystem.rmdir(path);
  },
  unlink: async (path) => {
    await FileSystem.unlink(path);
  },
};

const errorCode = (error: unknown): string | number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (typeof error.code === "string" || typeof error.code === "number")
    ? error.code
    : undefined;

const errorReason = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  const code = errorCode(error);
  return code === undefined ? "unknown filesystem error" : String(code);
};

const lockKey = (value: string): string => Crypto.createHash("sha256").update(value).digest("hex");

const defaultRootDirectory = (): string => {
  const uid =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : process.env.USERNAME?.trim() || process.env.USER?.trim() || "unknown-user";
  return Path.join(OperatingSystem.tmpdir(), `${LOCK_DIRECTORY_PREFIX}-${lockKey(uid)}`);
};

const defaultProcessStartIdentity = async (
  pid: number,
): Promise<
  | { readonly state: "present"; readonly identity: string }
  | { readonly state: "absent" | "unknown" }
> => {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      windowsHide: true,
    });
    const identity = result.stdout.trim();
    return identity.length > 0 ? { state: "present", identity } : { state: "absent" };
  } catch (error) {
    // `ps` returns exit code 1 when a PID is absent. We intentionally use
    // only this read-only process inspection path; this module must never
    // signal or kill another process.
    return errorCode(error) === 1 ? { state: "absent" } : { state: "unknown" };
  }
};

const defaultProcess = (): SimulatorHostLockProcess => ({
  current: async () => {
    const pid = process.pid;
    const result = await defaultProcessStartIdentity(pid);
    if (result.state !== "present" || !("identity" in result)) {
      throw new Error(`could not establish process-start identity for pid ${pid}`);
    }
    return { pid, processStartIdentity: result.identity };
  },
  inspect: async (identity) => {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return "unknown";
    const result = await defaultProcessStartIdentity(identity.pid);
    if (result.state === "absent") return "dead";
    if (result.state === "unknown") return "unknown";
    return "identity" in result && result.identity === identity.processStartIdentity
      ? "alive"
      : "identity-mismatch";
  },
});

const isLockError = (error: unknown): error is SimulatorHostLockError =>
  Schema.is(SimulatorHostLockContendedError)(error) ||
  Schema.is(SimulatorHostLockUnknownOwnerError)(error) ||
  Schema.is(SimulatorHostLockReleaseMismatchError)(error) ||
  Schema.is(SimulatorHostLockFileSystemError)(error) ||
  Schema.is(SimulatorHostLockCorruptError)(error);

const decodeMetadata = (value: unknown): SimulatorHostLockMetadata | undefined => {
  try {
    return Schema.decodeUnknownSync(SimulatorHostLockMetadata)(value);
  } catch {
    return undefined;
  }
};

const makeFileSystemError = (
  input: Pick<SimulatorHostLockInput, "udid">,
  path: string,
  operation: string,
  error: unknown,
): SimulatorHostLockFileSystemError =>
  new SimulatorHostLockFileSystemError({
    udid: input.udid,
    path,
    operation,
    reason: errorReason(error),
  });

const ownerForError = (
  metadata: SimulatorHostLockMetadata,
  path: string,
): SimulatorHostLockContendedError =>
  new SimulatorHostLockContendedError({
    udid: metadata.udid,
    path,
    ownerEnvironmentId: metadata.environmentId,
    ownerThreadId: metadata.threadId,
    ownerLeaseId: metadata.leaseId,
    ownerPid: metadata.pid,
    ownerProcessStartIdentity: metadata.processStartIdentity,
    acquiredAt: metadata.acquiredAt,
  });

const metadataPath = (lockPath: string): string => Path.join(lockPath, OWNER_FILE_NAME);

const isAlreadyExists = (error: unknown): boolean => errorCode(error) === "EEXIST";
const isNotFound = (error: unknown): boolean => errorCode(error) === "ENOENT";

const removeReclaimedLock = async (
  fileSystem: SimulatorHostLockFileSystem,
  path: string,
): Promise<void> => {
  // There should be only owner.json and temporary owner files created by
  // this module. Remove those known files, then rmdir the exact quarantine
  // directory. Unexpected entries cause rmdir to fail and the caller fails
  // closed without recursively deleting arbitrary data.
  try {
    await fileSystem.unlink(metadataPath(path));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const entries = await fileSystem.readdir(path);
  for (const entry of entries) {
    if (!entry.startsWith(`${OWNER_FILE_NAME}.reclaim-`)) continue;
    try {
      await fileSystem.unlink(Path.join(path, entry));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  await fileSystem.rmdir(path);
};

const makeHostLock = (options: SimulatorHostLockOptions = {}): SimulatorHostLock => {
  const rootDirectory = options.rootDirectory ?? defaultRootDirectory();
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const processApi = options.process ?? defaultProcess();
  const now = options.now ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => Crypto.randomUUID());

  const pathsFor = (udid: SimulatorUdid) => {
    const path = Path.join(rootDirectory, `${lockKey(udid)}.lock`);
    return { path, ownerPath: metadataPath(path) };
  };

  const readExistingMetadata = async (
    input: Pick<SimulatorHostLockInput, "udid">,
    path: string,
  ): Promise<SimulatorHostLockMetadata> => {
    let encoded: string;
    try {
      encoded = await fileSystem.readFile(metadataPath(path), "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        throw new SimulatorHostLockUnknownOwnerError({
          udid: input.udid,
          path,
          reason: "owner metadata is not present",
        });
      }
      throw makeFileSystemError(input, path, "read-owner", error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new SimulatorHostLockCorruptError({
        udid: input.udid,
        path,
        reason: "owner metadata is not valid JSON",
      });
    }
    const metadata = decodeMetadata(parsed);
    if (!metadata || metadata.udid !== input.udid) {
      throw new SimulatorHostLockCorruptError({
        udid: input.udid,
        path,
        reason: "owner metadata does not match the requested UDID",
      });
    }
    return metadata;
  };

  const acquireAsync = async (input: SimulatorHostLockInput): Promise<SimulatorHostLockLease> => {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new SimulatorHostLockCorruptError({
        udid: input.udid,
        path: rootDirectory,
        reason: "generation must be a positive integer",
      });
    }

    let currentIdentity: SimulatorHostProcessIdentity;
    try {
      currentIdentity = await processApi.current();
    } catch (error) {
      throw new SimulatorHostLockUnknownOwnerError({
        udid: input.udid,
        path: rootDirectory,
        reason: `could not establish current process identity: ${errorReason(error)}`,
      });
    }
    if (
      !Number.isSafeInteger(currentIdentity.pid) ||
      currentIdentity.pid <= 0 ||
      currentIdentity.processStartIdentity.trim().length === 0
    ) {
      throw new SimulatorHostLockUnknownOwnerError({
        udid: input.udid,
        path: rootDirectory,
        reason: "current process identity is incomplete",
      });
    }

    try {
      await fileSystem.mkdir(rootDirectory, { recursive: true, mode: LOCK_DIRECTORY_MODE });
    } catch (error) {
      throw makeFileSystemError(input, rootDirectory, "create-root", error);
    }

    const { path, ownerPath } = pathsFor(input.udid);
    for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
      try {
        await fileSystem.mkdir(path, { mode: LOCK_DIRECTORY_MODE });
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw makeFileSystemError(input, path, "create-lock", error);
        }

        const metadata = await readExistingMetadata(input, path);
        const ownerState = await processApi.inspect({
          pid: metadata.pid,
          processStartIdentity: metadata.processStartIdentity,
        });
        if (ownerState === "alive") throw ownerForError(metadata, path);
        if (ownerState === "unknown") {
          throw new SimulatorHostLockUnknownOwnerError({
            udid: input.udid,
            path,
            reason: "recorded process identity could not be verified",
          });
        }

        // Rename is atomic within the same temporary directory. A competing
        // acquirer can create a replacement lock while the quarantine is
        // being removed, without its directory being accidentally removed.
        const quarantinePath = `${path}.reclaim-${randomToken()}`;
        try {
          await fileSystem.rename(path, quarantinePath);
        } catch (renameError) {
          if (isNotFound(renameError)) continue;
          throw makeFileSystemError(input, path, "quarantine-stale-lock", renameError);
        }
        try {
          await removeReclaimedLock(fileSystem, quarantinePath);
        } catch (removeError) {
          throw makeFileSystemError(input, quarantinePath, "remove-stale-lock", removeError);
        }
        continue;
      }

      const acquiredAt = now().toISOString();
      const metadata: SimulatorHostLockMetadata = {
        version: 1,
        udid: input.udid,
        ownerToken: randomToken(),
        environmentId: input.environmentId,
        threadId: input.threadId,
        leaseId: input.leaseId,
        generation: input.generation,
        pid: currentIdentity.pid,
        processStartIdentity: currentIdentity.processStartIdentity,
        createdAt: acquiredAt,
        acquiredAt,
        updatedAt: acquiredAt,
      };
      const temporaryOwnerPath = `${ownerPath}.reclaim-${metadata.ownerToken}`;
      try {
        await fileSystem.writeFile(temporaryOwnerPath, JSON.stringify(metadata), {
          encoding: "utf8",
          flag: "wx",
          mode: OWNER_FILE_MODE,
        });
        await fileSystem.rename(temporaryOwnerPath, ownerPath);
      } catch (writeError) {
        try {
          await fileSystem.unlink(temporaryOwnerPath);
        } catch (cleanupError) {
          if (!isNotFound(cleanupError)) {
            // Preserve the original failure while making the lock leak
            // visible through the typed filesystem error.
            throw makeFileSystemError(input, path, "write-owner-cleanup", cleanupError);
          }
        }
        throw makeFileSystemError(input, path, "write-owner", writeError);
      }
      return { path, metadata };
    }

    throw new SimulatorHostLockUnknownOwnerError({
      udid: input.udid,
      path,
      reason: "lock changed repeatedly while reclaiming a stale owner",
    });
  };

  const releaseAsync = async (lease: SimulatorHostLockLease): Promise<void> => {
    let currentIdentity: SimulatorHostProcessIdentity;
    try {
      currentIdentity = await processApi.current();
    } catch (error) {
      throw new SimulatorHostLockReleaseMismatchError({
        udid: lease.metadata.udid,
        path: lease.path,
        reason: `could not establish current process identity: ${errorReason(error)}`,
      });
    }
    let currentMetadata: SimulatorHostLockMetadata | undefined;
    try {
      const encoded = await fileSystem.readFile(metadataPath(lease.path), "utf8");
      currentMetadata = decodeMetadata(JSON.parse(encoded));
    } catch (error) {
      throw new SimulatorHostLockReleaseMismatchError({
        udid: lease.metadata.udid,
        path: lease.path,
        reason: `could not read current owner metadata: ${errorReason(error)}`,
      });
    }
    if (
      !currentMetadata ||
      currentMetadata.udid !== lease.metadata.udid ||
      currentMetadata.ownerToken !== lease.metadata.ownerToken ||
      currentMetadata.environmentId !== lease.metadata.environmentId ||
      currentMetadata.threadId !== lease.metadata.threadId ||
      currentMetadata.leaseId !== lease.metadata.leaseId ||
      currentMetadata.generation !== lease.metadata.generation ||
      currentMetadata.pid !== currentIdentity.pid ||
      currentMetadata.processStartIdentity !== currentIdentity.processStartIdentity ||
      currentMetadata.createdAt !== lease.metadata.createdAt ||
      currentMetadata.acquiredAt !== lease.metadata.acquiredAt ||
      currentMetadata.updatedAt !== lease.metadata.updatedAt
    ) {
      throw new SimulatorHostLockReleaseMismatchError({
        udid: lease.metadata.udid,
        path: lease.path,
        reason: "owner token or process identity does not match",
      });
    }
    const releasePath = `${lease.path}.release-${lease.metadata.ownerToken}`;
    try {
      await fileSystem.rename(lease.path, releasePath);
      await removeReclaimedLock(fileSystem, releasePath);
    } catch (error) {
      throw makeFileSystemError(lease.metadata, lease.path, "release-lock", error);
    }
  };

  return {
    acquire: (input) =>
      Effect.tryPromise({
        try: () => acquireAsync(input),
        catch: (error) =>
          isLockError(error) ? error : makeFileSystemError(input, rootDirectory, "acquire", error),
      }),
    release: (lease) =>
      Effect.tryPromise({
        try: () => releaseAsync(lease),
        catch: (error) =>
          isLockError(error)
            ? error
            : new SimulatorHostLockReleaseMismatchError({
                udid: lease.metadata.udid,
                path: lease.path,
                reason: errorReason(error),
              }),
      }),
  };
};

export interface SimulatorHostLock {
  readonly acquire: (
    input: SimulatorHostLockInput,
  ) => Effect.Effect<SimulatorHostLockLease, SimulatorHostLockError>;
  readonly release: (lease: SimulatorHostLockLease) => Effect.Effect<void, SimulatorHostLockError>;
}

export const make = makeHostLock;

export const makeEffect = (
  options: SimulatorHostLockOptions = {},
): Effect.Effect<SimulatorHostLock> => Effect.sync(() => makeHostLock(options));
