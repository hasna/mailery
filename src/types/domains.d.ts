declare module "@hasna/domains" {
  export interface Route53Availability {
    available: boolean;
    price?: string | number;
    currency?: string;
  }

  export interface Route53RegistrationResult {
    operationId: string;
  }

  export interface Route53RegistrationStatus {
    status: string;
    domain?: string;
    message?: string;
  }

  export interface Route53RegisteredDomain {
    domain: string;
    expiry?: string;
    auto_renew?: boolean;
  }

  export interface Route53HostedZone {
    id: string;
    name_servers?: string[];
  }

  export interface CloudflareZone {
    id: string;
    nameservers: string[];
  }

  export interface Route53Record {
    name: string;
    type: string;
    ttl?: number;
    values: string[];
  }

  export function r53CheckAvailability(domain: string): Promise<Route53Availability>;
  export function r53RegisterDomain(domain: string, contact: unknown, years?: number): Promise<Route53RegistrationResult>;
  export function r53GetRegistrationStatus(operationId: string): Promise<Route53RegistrationStatus>;
  export function r53ListRegisteredDomains(): Promise<Route53RegisteredDomain[]>;
  export function r53CreateHostedZone(domain: string, comment?: string): Promise<Route53HostedZone>;
  export function r53FindHostedZoneByDomain(domain: string): Promise<Route53HostedZone | null>;
  export function r53UpsertRecords(zoneId: string, records: Route53Record[]): Promise<unknown>;
  export function cfEnsureZone(domain: string): Promise<CloudflareZone>;
  export function r53UpdateNameservers(domain: string, nameservers: string[]): Promise<unknown>;
  export function pollRegistrationUntilDone(
    operationId: string,
    opts: { getStatus: (id: string) => Promise<Route53RegistrationStatus> },
  ): Promise<{ status: "success" | "failed" | "pending"; message?: string }>;
}
