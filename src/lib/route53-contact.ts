export interface Route53RegistrationContactInput {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address_line_1: string;
  city: string;
  country_code: string;
  zip_code: string;
  state?: string | null;
  organization_name?: string | null;
}

export type Route53RegistrationContact = Omit<Route53RegistrationContactInput, "state" | "organization_name"> & {
  state?: string;
  organization_name?: string;
};

const ROUTE53_STATE_FORBIDDEN_COUNTRIES = new Set(["RO"]);

export function route53ContactAllowsState(countryCode: string | undefined | null): boolean {
  if (!countryCode) return true;
  return !ROUTE53_STATE_FORBIDDEN_COUNTRIES.has(countryCode.trim().toUpperCase());
}

export function normalizeRoute53RegistrationContact(input: Route53RegistrationContactInput): Route53RegistrationContact {
  const contact: Route53RegistrationContact = {
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone,
    address_line_1: input.address_line_1,
    city: input.city,
    country_code: input.country_code.trim().toUpperCase(),
    zip_code: input.zip_code,
  };

  const organization = input.organization_name?.trim();
  if (organization) contact.organization_name = organization;

  const state = input.state?.trim();
  if (state && route53ContactAllowsState(contact.country_code)) {
    contact.state = state;
  }

  return contact;
}
