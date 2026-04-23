# Example 1 — Top Shot Moment, end-to-end

Live reference instance: <https://topshot-auth-portal.vercel.app>

This example walks through a full OPO verification of a single Top Shot
Moment using only public chain-state + a non-issuer IPFS gateway. Every step
maps to a row in the portal's "Layers of authentication" table.

## Inputs

```
chain     = flow-mainnet
contract  = A.0b2a3299cc857e29.TopShot
token_id  = 1234567
```

## Step 1 — read chain fields

`POST https://rest-mainnet.onflow.org/v1/scripts` with the script in
[`adapters/flow-topshot/cadence/getMomentMetadata.cdc`](../adapters/flow-topshot/cadence/getMomentMetadata.cdc)
returns:

```
editionID    = 110
serial       = 42
editionSize  = 4500
holder       = 0x0bb3b2a249ca6822
mediaCID     = bafybei… (CIDv1)
metadataCID  = bafybei… (CIDv1)
```

Reproduce: [Flow REST scripts API](https://developers.flow.com/http-api#tag/Scripts)
/ [Flowscan contract page](https://flowscan.io/contract/A.0b2a3299cc857e29.TopShot).

## Step 2 — serial in range

`1 ≤ 42 ≤ 4500` — passes.

## Step 3 — media CID hash

`GET https://dweb.link/ipfs/{mediaCID}` returns the highlight bytes. The
sha2-256 digest of those bytes MUST decode-match the multihash inside the
CID. The portal exposes the CID and the gateway link; a verifier can re-run
the hash locally with one line of Node, Python, or `ipfs cid hash`.

## Step 4 — metadata consistency

`GET https://dweb.link/ipfs/{metadataCID}` returns JSON. The JSON's
`editionID`, `serial`, and `mediaCID` fields MUST equal the chain-derived
values from step 1. Mismatch → not conforming.

## Result

```json
{
  "spec_version": "0.1",
  "result": "conforming",
  "fields": { … },
  "steps": [
    {"step": 1, "name": "read_chain_fields",   "ok": true},
    {"step": 2, "name": "serial_in_range",     "ok": true},
    {"step": 3, "name": "media_cid_hash",      "ok": true},
    {"step": 4, "name": "metadata_consistent", "ok": true}
  ],
  "failed_step": null
}
```

## What this verification does NOT establish

Per [SPEC.md §6](../SPEC.md#6-out-of-scope-permanent-limits):

- The Moment's market price, scarcity rank, or trade history.
- The holder's real-world identity or any custody arrangement off-chain.
- Top Shot Score, challenge progress, Showcase arrangement, set-completion
  badges, or full-team bonus state — these are application-layer constructs
  not bound to chain-state.
- Long-term IPFS pinning. OPO confirms retrievability at query time, not a
  durability commitment.
- Pre-migration editions whose CID↔Moment binding lives in the Dapper
  metadata API. Independent verification of that subset waits on Layer-5
  migration of those records to chain-pinned manifests.

These are permanent limits of the verification methodology, not a roadmap.
