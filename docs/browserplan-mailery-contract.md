# BrowserPlan Mailery Contract

Mailery is the email source for BrowserPlan profile creation. BrowserPlan should
consume existing Mailery addresses and open-identities records; it must not
create duplicate identities or email address rows.

## CLI

```bash
mailery --json browserplan coverage --machine machine003 --target 8
mailery --json browserplan addresses --machine machine003 --target 8 --limit 100
mailery --json browserplan validate hello@example.com --machine machine003
mailery --json browserplan reserve hello@example.com \
  --machine machine003 \
  --address-id addr_... \
  --identity-id oid_... \
  --identity-identifier agent:name \
  --identity-name "Display Name" \
  --identity-email name@example.com
```

`reserve` requires an existing open-identities `id` or `identifier`. It creates
or reuses a Mailery owner with `external_id` set to the stable open-identities
`id` when provided, falling back to `identifier` only when no `id` is supplied, then
assigns one receive-ready address to that owner. It does not create an
open-identities identity and does not create a new email address.

If the selected Mailery address already matches a different open-identities
record by email, reservation fails with a conflict. Auto-pick skips addresses
that already map to other identities and prefers an unowned ready address that
maps to the requested identity when one exists.

For human identities, pass `--administrator <mailery-owner-ref>` so the address
can be administered by an agent owner.

## SDK

```ts
import {
  listBrowserPlanAddresses,
  reserveBrowserPlanAddress,
  validateBrowserPlanAddress,
} from "@hasna/mailery";

const coverage = listBrowserPlanAddresses({ machineId: "machine003", target: 8 });
const validation = validateBrowserPlanAddress({ machineId: "machine003", email: "hello@example.com" });
const reservation = reserveBrowserPlanAddress({
  machineId: "machine003",
  email: "hello@example.com",
  addressId: "addr_...",
  identity: {
    id: "oid_...",
    identifier: "agent:name",
    name: "Display Name",
    email: "name@example.com",
    kind: "agent",
  },
});
```

`listBrowserPlanAddresses` returns counts for receive-ready capacity,
identity-linked ready addresses, available unowned ready addresses, and per
address identity metadata. Identity metadata is resolved in this order:

1. Existing Mailery owner on the address.
2. Matching email in the open-identities JSON store.
3. Tentative fallback derived from the email local part.

Set `OPEN_IDENTITIES_STORE` or pass `identityStorePath` to use a non-default
open-identities store.

SDK callers running centrally can pass `machineId` as a label while executing
inside a `machines ssh` command. REST callers must treat `machine_id` as an
assertion about the local Mailery process; it must match `MAILERY_MACHINE_ID`,
`MACHINE_ID`, or the fleet-style hostname.

## REST

The local dashboard API exposes the same contract:

```http
GET /api/browserplan/coverage?machine_id=machine003&target=8
GET /api/browserplan/addresses?machine_id=machine003&target=8&limit=100
GET /api/browserplan/validate?machine_id=machine003&email=hello@example.com
POST /api/browserplan/reservations
```

Reservation body:

```json
{
  "machine_id": "machine003",
  "address_id": "addr_...",
  "email": "hello@example.com",
  "identity": {
    "id": "oid_...",
    "identifier": "agent:name",
    "name": "Display Name",
    "email": "name@example.com",
    "kind": "agent"
  }
}
```

The REST API is local-dashboard scoped. For fleet orchestration, run the CLI or
SDK on the target machine through `machines ssh`.
