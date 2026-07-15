import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function directoryChain(path) {
  const chain = [];
  let current = resolve(path);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

function canonicalizeFromExistingAncestor(path) {
  const resolvedPath = resolve(path);
  const missingComponents = [];
  let existingAncestor = resolvedPath;
  while (!lstatIfExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingComponents.push(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = realpathSync(existingAncestor);
  return missingComponents.length === 0
    ? canonicalAncestor
    : join(canonicalAncestor, ...missingComponents.reverse());
}

function validateAncestorChain(path) {
  const uid = process.getuid();
  for (const component of directoryChain(path)) {
    const stats = lstatSync(component);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing app data ancestor at ${component}: symbolic links are not allowed`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Refusing app data ancestor at ${component}: expected a directory`);
    }

    let fd;
    try {
      fd = openSync(component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const fdStats = fstatSync(fd);
      if (!fdStats.isDirectory() || fdStats.dev !== stats.dev || fdStats.ino !== stats.ino) {
        throw new Error(`Refusing app data ancestor at ${component}: validation failed`);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    const mode = stats.mode & 0o7777;
    const writableByOthers = (mode & 0o022) !== 0;
    const trustedSticky = (mode & 0o1000) !== 0 && (stats.uid === uid || stats.uid === 0);
    if (writableByOthers && !trustedSticky) {
      throw new Error(`Refusing unsafe app data ancestor at ${component}: shared-writable directories are not allowed`);
    }
    // Mode bits are mutable by the owner, so a foreign-owned ancestor remains
    // unsafe even when it appears non-writable at validation time.
    if (stats.uid !== uid && stats.uid !== 0) {
      throw new Error(`Refusing unsafe app data ancestor at ${component}: it is owned by foreign uid ${stats.uid}`);
    }
  }
}

function validateOwnedDirectory(path, expectedMode, repairMode) {
  if (!lstatIfExists(path)) {
    try {
      mkdirSync(path, { mode: expectedMode });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  const pathStats = lstatSync(path);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Refusing app data directory at ${path}: symbolic links are not allowed`);
  }
  if (!pathStats.isDirectory()) {
    throw new Error(`Refusing app data directory at ${path}: expected a directory`);
  }
  const uid = process.getuid();
  if (pathStats.uid !== uid) {
    throw new Error(`Refusing app data directory at ${path}: it is not owned by the current user`);
  }

  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdStats = fstatSync(fd);
    if (!fdStats.isDirectory() || fdStats.uid !== uid) {
      throw new Error(`Refusing app data directory at ${path}: validation failed`);
    }
    if (pathStats.dev !== fdStats.dev || pathStats.ino !== fdStats.ino) {
      throw new Error(`Refusing filesystem race at ${path}: the path changed during validation`);
    }
    if (repairMode) fchmodSync(fd, expectedMode);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const finalStats = lstatSync(path);
  if (
    finalStats.isSymbolicLink()
    || !finalStats.isDirectory()
    || finalStats.uid !== uid
    || finalStats.dev !== pathStats.dev
    || finalStats.ino !== pathStats.ino
    || ((finalStats.mode & 0o022) !== 0)
    || (repairMode && (finalStats.mode & 0o777) !== expectedMode)
  ) {
    throw new Error(`Could not protect app data directory at ${path}`);
  }
}

if (process.platform !== "win32") {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  // Canonicalize HOME once so stable aliases such as macOS /var and /tmp are
  // accepted, then operate only beneath their canonical target. App-owned
  // .hasna/emails components are still validated without following symlinks.
  const canonicalHome = canonicalizeFromExistingAncestor(home);
  validateAncestorChain(canonicalHome);
  const hasnaDir = join(canonicalHome, ".hasna");
  // ~/.hasna is shared by Hasna applications. Preserve safe modes such as
  // 0755; only this package's own data directory is repaired to 0700.
  validateOwnedDirectory(hasnaDir, 0o755, false);
  validateOwnedDirectory(join(hasnaDir, "emails"), 0o700, true);
}
