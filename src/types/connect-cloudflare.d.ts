declare module "@hasna/connect-cloudflare" {
  export interface CloudflareDnsRecord {
    type: string;
    name: string;
    content: string;
  }

  export interface CloudflareZone {
    id: string;
    name: string;
    name_servers?: string[];
  }

  export interface CloudflareListResult<T> {
    result?: T[];
  }

  export interface CloudflareOptions {
    apiToken?: string;
  }

  export class Cloudflare {
    constructor(options?: CloudflareOptions);
    static create(): Cloudflare;
    dns: {
      list(zoneId: string, params?: Record<string, unknown>): Promise<CloudflareListResult<CloudflareDnsRecord>>;
      create(zoneId: string, record: Record<string, unknown>): Promise<unknown>;
    };
    zones: {
      list(params?: Record<string, unknown>): Promise<CloudflareListResult<CloudflareZone>>;
    };
  }
}
