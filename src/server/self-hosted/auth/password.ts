// Password hashing for self-hosted user accounts — argon2id via Bun.password.
//
// Design ref: docs/design/multi-tenancy-auth.md §4.1. argon2id is OWASP's
// first-choice password hash (memory-hard, GPU/ASIC-resistant). Bun ships it
// natively, so this adds ZERO new dependencies and no native addon / supply-chain
// surface. The full PHC string (which encodes the cost params) is what we store,
// so verification and future re-tuning are transparent and we can rehash on login
// when the encoded params drift from current policy.
//
// This module is pure (no DB, no I/O beyond the hash primitive) and unit-tested.

/** argon2id cost parameters. `memoryCost` is in KiB (Bun's unit). */
export interface Argon2idParams {
  /** Memory cost in KiB. 19456 KiB ≈ 19 MiB (OWASP-recommended floor). */
  readonly memoryCost: number;
  /** Iteration (time) cost. */
  readonly timeCost: number;
}

/**
 * Current policy. Explicit (not "whatever Bun defaults to") so `needsRehash` is
 * deterministic and independent of Bun-version default drift. Tune upward on the
 * deploy host toward ~50-100ms/verify; raising these here makes existing hashes
 * rehash-on-login automatically.
 */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
});

const ARGON2ID_ALGORITHM = "argon2id" as const;

export interface ParsedPhc {
  readonly algorithm: string;
  readonly version?: number;
  readonly memoryCost?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
}

/**
 * Parse a PHC-format hash string enough to read its algorithm + cost params.
 * Returns null for anything that is not a recognizable `$algo$...` PHC string.
 * Shape: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
 */
export function parseArgon2Phc(hash: string): ParsedPhc | null {
  if (typeof hash !== "string" || hash[0] !== "$") return null;
  const parts = hash.split("$");
  // ['', algo, 'v=..', 'm=..,t=..,p=..', salt, hash]
  if (parts.length < 4) return null;
  const algorithm = parts[1];
  if (!algorithm) return null;

  let version: number | undefined;
  let paramsSegment: string | undefined;
  if (parts[2]?.startsWith("v=")) {
    version = Number.parseInt(parts[2].slice(2), 10);
    paramsSegment = parts[3];
  } else {
    // Some encoders omit the version segment.
    paramsSegment = parts[2];
  }

  const parsed: {
    algorithm: string;
    version?: number;
    memoryCost?: number;
    timeCost?: number;
    parallelism?: number;
  } = { algorithm };
  if (version !== undefined && Number.isFinite(version)) parsed.version = version;

  if (paramsSegment && paramsSegment.includes("=")) {
    for (const kv of paramsSegment.split(",")) {
      const [key, rawValue] = kv.split("=");
      const value = Number.parseInt(rawValue ?? "", 10);
      if (!Number.isFinite(value)) continue;
      if (key === "m") parsed.memoryCost = value;
      else if (key === "t") parsed.timeCost = value;
      else if (key === "p") parsed.parallelism = value;
    }
  }
  return parsed;
}

/** Hash a plaintext password with argon2id at the given (or current) policy. */
export async function hashPassword(
  password: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  return Bun.password.hash(password, {
    algorithm: ARGON2ID_ALGORITHM,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
  });
}

/**
 * Verify a plaintext password against a stored PHC hash. Never throws on a
 * malformed hash — returns false — so a corrupt stored value cannot 500 a login.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof hash !== "string" || !hash) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash should be re-hashed on the next successful login: it is
 * not argon2id, or its encoded cost params differ from current policy. Callers
 * rehash opportunistically (the plaintext is only in hand at login time).
 */
export function needsRehash(hash: string, params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS): boolean {
  const parsed = parseArgon2Phc(hash);
  if (!parsed) return true;
  if (parsed.algorithm !== ARGON2ID_ALGORITHM) return true;
  if (parsed.memoryCost !== params.memoryCost) return true;
  if (parsed.timeCost !== params.timeCost) return true;
  return false;
}

// --- constant-time timing equalization for unknown accounts (design §8) -------
//
// login/reset must take the same wall-clock time whether or not the email
// resolves to a user, so an attacker cannot enumerate accounts by timing. When
// the account is unknown we still run a full argon2id verify against a fixed,
// valid dummy hash and then return false. The dummy is computed once (at current
// policy so its cost matches a real verify) and cached.

let dummyHashPromise: Promise<string> | null = null;

/** A valid argon2id hash (of an unguessable throwaway secret), computed once. */
export function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    const throwaway = `dummy:${crypto.randomUUID()}:${crypto.randomUUID()}`;
    dummyHashPromise = hashPassword(throwaway);
  }
  return dummyHashPromise;
}

/**
 * Timing-safe verify used by the login/auth path: pass the stored hash, or null
 * when the account does not exist. When null, a full verify still runs against
 * the dummy hash (equal cost) and the result is always false. Returns true only
 * for a real, matching credential.
 */
export async function verifyPasswordOrEqualizeTiming(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (hash) return verifyPassword(password, hash);
  await verifyPassword(password, await dummyPasswordHash());
  return false;
}
