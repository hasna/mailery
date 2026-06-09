import { ansi } from "./ansi.js";
import type { Provider } from "../types/index.js";

export interface ProviderHealth {
  provider: Provider;
  credentialsValid: boolean;
  credentialsChecked: boolean;
  credentialError?: string;
  domainCount: number;
  verifiedDomains: number;
  addressCount: number;
  verifiedAddresses: number;
  bounceRate: number;
  status: "healthy" | "warning" | "error";
}

export function formatProviderHealth(h: ProviderHealth): string {
  const statusIcon = h.status === "healthy" ? ansi.green("●") : h.status === "warning" ? ansi.yellow("●") : ansi.red("●");
  const creds = h.credentialsValid
    ? ansi.green(h.credentialsChecked ? "valid" : "configured")
    : ansi.red(`${h.credentialsChecked ? "invalid" : "missing"}: ${h.credentialError || "unknown"}`);
  const domains = `${h.verifiedDomains}/${h.domainCount} verified`;
  const addresses = `${h.verifiedAddresses}/${h.addressCount} verified`;
  const bounce = h.bounceRate > 5 ? ansi.red(`${h.bounceRate.toFixed(1)}%`) : ansi.green(`${h.bounceRate.toFixed(1)}%`);

  return [
    `${statusIcon} ${ansi.bold(h.provider.name)} (${h.provider.type})`,
    `  Credentials: ${creds}`,
    `  Domains: ${domains}`,
    `  Addresses: ${addresses}`,
    `  Bounce rate (30d): ${bounce}`,
  ].join("\n");
}
