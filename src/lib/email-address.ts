/**
 * Strict sender-address parsing for authorization.
 *
 * A From header may be `addr@domain` or `Display Name <addr@domain>`. For
 * authorization we must extract the SINGLE canonical address and REJECT any
 * ambiguous value — notably a string with more than one angle-addr
 * (`x <a@evil> <ceo@corp>`), which different mail clients render differently
 * and which would otherwise let a caller authorize against one address while
 * the recipient sees another.
 */

/**
 * Return the lowercase canonical address of an unambiguous sender, or null if
 * the value is ambiguous/malformed (callers treat null as "deny").
 */
export function canonicalSender(from: string): string | null {
  if (typeof from !== "string") return null;
  const value = from.trim();
  if (!value) return null;

  const lt = (value.match(/</g) || []).length;
  const gt = (value.match(/>/g) || []).length;

  let addr: string;
  if (lt === 0 && gt === 0) {
    // Bare address form — must be exactly one addr-spec, no spaces.
    addr = value;
    if (/\s/.test(addr)) return null;
  } else {
    // Angle-addr form — require exactly one `<...>` pair and nothing after it.
    if (lt !== 1 || gt !== 1) return null;
    const m = value.match(/^[^<>]*<([^<>]+)>$/);
    if (!m) return null;
    addr = m[1]!.trim();
  }

  // Exactly one @, non-empty local and domain, no whitespace.
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@") || at === addr.length - 1) return null;
  if (/\s/.test(addr)) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1).toLowerCase();
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;
  if (domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return addr.toLowerCase();
}
