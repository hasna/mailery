import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

const TOP_LEVEL = new Set(["package.json", "README.md", "LICENSE", "NOTICE", "bun.lock", "bunfig.toml", ".gitignore", "public-source-files.json"]);
const EXTRA_PATHS = new Set(["docs/openapi.json", "scripts/prepublish-allowlist.sh", "scripts/check-public-source.ts", "scripts/public-source.test.ts", ".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]);

function allowedPath(path: string): boolean {
  return TOP_LEVEL.has(path) || EXTRA_PATHS.has(path) || /^packages\/(cli|sdk)\/(package\.json|tsconfig\.json|README\.md|LICENSE|NOTICE)$/.test(path)
    || /^packages\/(cli|sdk)\/(src|test)\/[a-z][a-z0-9-]*\.ts$/.test(path)
    || /^packages\/(cli|sdk)\/test\/[a-z][a-z0-9-]*\.test\.ts$/.test(path);
}

function paths(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const name = relative(root, full).split(sep).join("/");
    requireCondition(!entry.isSymbolicLink(), `symlink in public source: ${name}`);
    if (entry.isDirectory()) {
      if (name === ".git" || entry.name === "node_modules" || /^packages\/(cli|sdk)\/dist$/.test(name)) continue;
      result.push(...paths(root, full));
    } else { result.push(name); }
  }
  return result.sort();
}

function checkModule(root: string, file: string): void {
  const code = readFileSync(join(root, file), "utf8");
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const packageSource = resolve(root, file.split("/").slice(0, 3).join("/"));
  function checkSpecifier(specifier: string): void {
    if (specifier.startsWith(".")) {
      const target = resolve(root, dirname(file), specifier.replace(/\.js$/, ".ts"));
      requireCondition(target.startsWith(packageSource + sep) && existsSync(target), `relative client import escapes source: ${file}`);
    } else {
      requireCondition(specifier === "commander" || specifier === "@hasna/mailery-sdk-internal" || (file === "packages/cli/src/program.ts" && ["node:child_process", "node:crypto", "node:fs/promises", "node:path"].includes(specifier)), `external client import: ${file}`);
    }
  }
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      requireCondition(ts.isStringLiteral(node.moduleSpecifier), `nonliteral client import: ${file}`);
      checkSpecifier(node.moduleSpecifier.text);
    }
    requireCondition(!(ts.isIdentifier(node) && node.text === "require"), `dynamic require in client: ${file}`);
    requireCondition(!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword), `dynamic client import: ${file}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export function checkPublicSource(root: string): string[] {
  const expected = readJson(join(root, "public-source-files.json")) as string[];
  requireCondition(Array.isArray(expected) && new Set(expected).size === expected.length && expected.every((name) => typeof name === "string" && allowedPath(name)), "invalid public source manifest");
  requireCondition(!expected.includes("packages/cli/test/e2e.test.ts"), "private server E2E must remain in private CI");
  const found = paths(root);
  for (const name of found) requireCondition(expected.includes(name), `unexpected public file: ${name}`);
  for (const name of expected) requireCondition(found.includes(name), `missing public file: ${name}`);
  for (const name of found.filter((name) => /^packages\/(cli|sdk)\/src\//.test(name))) checkModule(root, name);
  const workspace = readJson(join(root, "package.json"));
  const cli = readJson(join(root, "packages/cli/package.json"));
  const sdk = readJson(join(root, "packages/sdk/package.json"));
  requireCondition(workspace.private === true && JSON.stringify(workspace.workspaces) === '["packages/cli","packages/sdk"]' && Object.keys(workspace.dependencies ?? {}).length === 0, "public workspace boundary");
  requireCondition(cli.name === "@hasna/mailery" && cli.publishConfig?.provenance === true && cli.publishConfig?.access === "public" && cli.repository?.url === "git+https://github.com/hasna/mailery.git", "public package identity");
  requireCondition(sdk.private === true && sdk.repository?.url === "git+https://github.com/hasna/mailery.git" && Object.keys(sdk.dependencies ?? {}).length === 0, "internal SDK publication boundary");
  requireCondition(JSON.stringify(cli.dependencies) === '{"commander":"13.1.0"}', "client runtime dependencies");
  const lock = ts.parseConfigFileTextToJson("bun.lock", readFileSync(join(root, "bun.lock"), "utf8"));
  const pinned: Record<string, string> = {
    "@hasna/mailery": "workspace:packages/cli", "@hasna/mailery-sdk-internal": "workspace:packages/sdk",
    "@types/bun": "1.2.4", "bun-types": "1.2.4", "@types/node": "25.9.3", "@types/ws": "8.5.14",
    "undici-types": "7.24.6", "commander": "13.1.0", "typescript": "5.7.3",
  };
  requireCondition(!lock.error && lock.config.lockfileVersion === 1 && JSON.stringify(Object.keys(lock.config.packages ?? {}).sort()) === JSON.stringify(Object.keys(pinned).sort()) && Object.entries(pinned).every(([name, version]) => lock.config.packages[name]?.[0] === `${name}@${version}`), "public dependency lock");
  const workflow = readFileSync(join(root, ".github/workflows/publish-npm.yml"), "utf8");
  for (const fragment of ["github.repository == 'hasna/mailery' && github.ref == 'refs/heads/main'", "environment: npm-publish", "id-token: write", "npm publish ./packages/cli --provenance --access public"]) requireCondition(workflow.includes(fragment), "public provenance workflow");
  for (const privateInput of ["src/server/", "src/runtime/", "prepublish-check.sh"]) requireCondition(!workflow.includes(privateInput), "private workflow input");
  const drift = readFileSync(join(root, "packages/sdk/test/openapi-drift.test.ts"), "utf8");
  requireCondition(!drift.includes("src/server/app.ts") && !drift.includes("serverRoutes()"), "private server drift dependency");
  return found;
}

if (import.meta.main) console.log(`public-source: ${checkPublicSource(resolve(import.meta.dir, "..")).length} files verified`);
