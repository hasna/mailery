// Kept in sync with package.json "version". Hardcoded (not imported) so the
// tsc rootDir:src typecheck never reaches outside src/, and so the bundled bin
// carries no filesystem read at startup.
export const VERSION = "0.2.0";
