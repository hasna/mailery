export type ServerMode = "local" | "self_hosted";

export interface ServerBindOptions {
  host: string;
  port: number;
}

function optionValue(args: string[], name: "--host" | "--port"): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      value = next;
      index++;
      continue;
    }

    const prefix = `${name}=`;
    if (arg?.startsWith(prefix)) {
      const inline = arg.slice(prefix.length);
      if (!inline) throw new Error(`${name} requires a value`);
      value = inline;
    }
  }

  return value;
}

function parsePort(raw: string, source: "--port" | "PORT"): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${source} must be an integer between 0 and 65535`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source} must be an integer between 0 and 65535`);
  }
  return port;
}

/** Resolve bind settings with explicit CLI > environment > mode-default precedence. */
export function resolveServerBindOptions(
  args: string[],
  env: Record<string, string | undefined>,
  mode: ServerMode,
): ServerBindOptions {
  const hostFlag = optionValue(args, "--host");
  const portFlag = optionValue(args, "--port");
  const defaultHost = mode === "self_hosted" ? "0.0.0.0" : "127.0.0.1";
  const defaultPort = mode === "self_hosted" ? 8080 : 3900;

  const envPort = env["PORT"] || undefined;
  return {
    host: hostFlag ?? env["HOST"] ?? defaultHost,
    port: portFlag !== undefined
      ? parsePort(portFlag, "--port")
      : envPort !== undefined
        ? parsePort(envPort, "PORT")
        : defaultPort,
  };
}
