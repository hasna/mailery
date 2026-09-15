// Domain availability presentation. Public CLI/MCP output intentionally hides
// billing economics and quote fields; billing internals remain server-side.

import type { MaileryDomainAvailability } from "@hasna/mailery-sdk-internal";

export type PublicDomainAvailability = Omit<
  MaileryDomainAvailability,
  "quoted_price_cents" | "quoted_price" | "currency"
>;

/** Return a public availability payload for CLI/MCP consumers. */
export function withPublicDomainAvailability(availability: MaileryDomainAvailability): PublicDomainAvailability {
  const { quoted_price_cents: _quotedPriceCents, quoted_price: _quotedPrice, currency: _currency, ...publicPayload } = availability;
  return publicPayload;
}
