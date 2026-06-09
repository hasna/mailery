import { describe, expect, it } from "bun:test";
import { normalizeRoute53RegistrationContact, route53ContactAllowsState } from "./route53-contact.js";

const baseContact = {
  first_name: "Mika",
  last_name: "Paper",
  email: "mika@example.com",
  phone: "+1.5551234567",
  address_line_1: "Main 1",
  city: "Seattle",
  country_code: "US",
  zip_code: "98101",
};

describe("Route53 registration contact normalization", () => {
  it("omits state for Romania because Route53 rejects it", () => {
    const contact = normalizeRoute53RegistrationContact({
      ...baseContact,
      city: "Bucuresti",
      country_code: "ro",
      state: "Bucuresti",
    });

    expect(contact.country_code).toBe("RO");
    expect(contact).not.toHaveProperty("state");
    expect(route53ContactAllowsState("RO")).toBe(false);
  });

  it("omits blank state values", () => {
    const contact = normalizeRoute53RegistrationContact({
      ...baseContact,
      state: "  ",
    });

    expect(contact).not.toHaveProperty("state");
  });

  it("preserves state for countries that allow it", () => {
    const contact = normalizeRoute53RegistrationContact({
      ...baseContact,
      state: " WA ",
      organization_name: "  Holy Paper  ",
    });

    expect(contact).toMatchObject({
      country_code: "US",
      state: "WA",
      organization_name: "Holy Paper",
    });
  });
});
