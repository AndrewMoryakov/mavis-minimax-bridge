# Duet Simple Orders Task

Use Mavis MiniMax Bridge Duet Relay to solve this task with two agents.

Input file:

- `examples/duet-simple-orders/input.json`

Create:

- `examples/duet-simple-orders/answer.json`

Rules:

1. Keep only the first occurrence of each order `id`.
2. Report duplicate ids in first-seen duplicate order.
3. Sum all amounts after duplicate removal.
4. Group totals by `currency`.
5. Find the top customer by total amount after duplicate removal.
6. Include `orderIds` in first-seen unique order.
7. Include `checksum`.

Expected answer shape:

```json
{
  "uniqueOrderCount": 0,
  "duplicateOrderIds": [],
  "totalAmount": 0,
  "totalsByCurrency": {
    "EUR": { "count": 0, "totalAmount": 0 },
    "USD": { "count": 0, "totalAmount": 0 }
  },
  "topCustomer": { "customer": "", "totalAmount": 0, "orderCount": 0 },
  "orderIds": [],
  "checksum": ""
}
```

Checksum rule:

- Build the answer object without `checksum`.
- Serialize it as canonical JSON with object keys sorted alphabetically at every
  level and no whitespace.
- `checksum` is the lowercase SHA-256 hex digest of that canonical JSON.

Acceptance:

```powershell
node .\examples\duet-simple-orders\verify.mjs
```

For intermediate answer-only checks before the relay is marked `done`:

```powershell
node .\examples\duet-simple-orders\verify.mjs --skip-relay-check
```

The final run must pass without `--skip-relay-check`.
