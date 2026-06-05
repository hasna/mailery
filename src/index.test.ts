import { describe, expect, it } from "bun:test";
import * as emails from "./index.js";

describe("public package entrypoint", () => {
  it("exports the documented library API surface", () => {
    for (const name of [
      "sendWithFailover",
      "createProvider",
      "listProviders",
      "createDomain",
      "listDomains",
      "createAddress",
      "listInboundEmails",
      "storeInboundEmail",
      "createTemplate",
      "renderTemplate",
      "upsertContact",
      "suppressContact",
      "createSequence",
      "addStep",
      "enroll",
      "exportEmailsJson",
      "exportEventsCsv",
      "createOwner",
      "setAddressOwnerByRef",
      "createSendKey",
      "assertSendAuthorized",
    ]) {
      expect(typeof (emails as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
