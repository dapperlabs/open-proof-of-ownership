# Example 1 — Top Shot Moment, end-to-end

Live reference instance: <https://topshot-auth-portal.vercel.app>

This example walks through a full OPO verification of one real Top Shot
Moment using only public chain-state + a non-issuer IPFS gateway. Every step
maps to a row in the portal's "Layers of authentication" table. Every step
is reproducible today with `curl` + `node` alone.

## Inputs

```
chain     = flow-mainnet
contract  = A.0b2a3299cc857e29.TopShot
token_id  = 40105574
holder    = 0x0bb3b2a249ca6822
```

## Step 1 — read chain fields

`POST https://rest-mainnet.onflow.org/v1/scripts` with the Cadence script in
[`adapters/flow-topshot/cadence/getMomentMetadata.cdc`](../adapters/flow-topshot/cadence/getMomentMetadata.cdc)
returns (after JSON-CDC decode):

```
editionID    = 90           (setID)
playID       = 3328
serial       = 1112
editionSize  = 16000
holder       = 0x0bb3b2a249ca6822
mediaCIDs    = [
  { rank: 2, cid: QmQbnTEh2FHct49adwcLc6U5qQqEGvwXpzSBQ8A5FSsmKR, mediaType: VIDEO_SQUARE },
  { rank: 4, cid: QmZCXuguHd1qa5iAHhvG6pMWy3LYsjuui3cKLmGMa9YUi7, mediaType: VIDEO },
  { rank: 6, cid: QmUXhVT3NT9VBV3B3VfnPj8PRVoh2s6a1dkRLvVk8t1Zsn, mediaType: HERO }
]
```

The adapter picks the lowest-ranked entry as `media_cid`:
`QmQbnTEh2FHct49adwcLc6U5qQqEGvwXpzSBQ8A5FSsmKR` (VIDEO_SQUARE).

Reproduce: [Flow REST scripts API](https://developers.flow.com/http-api#tag/Scripts)
/ [Flowscan contract page](https://flowscan.io/contract/A.0b2a3299cc857e29.TopShot).

## Step 2 — serial in range

`1 ≤ 1112 ≤ 16000` — passes.

## Step 3 — media CID hash

`GET https://dweb.link/ipfs/QmQbnTEh2FHct49adwcLc6U5qQqEGvwXpzSBQ8A5FSsmKR?format=raw`
returns 1209 bytes of dag-pb-encoded UnixFS. Sha2-256 over those bytes:

```
2197d77bcc86b685c18297a231f45be91b0729e37d2f97a6da70f62bcaa0abfc
```

Base58btc-decoding the CID yields the multihash:
`0x12 0x20 2197d77bcc86b685c18297a231f45be91b0729e37d2f97a6da70f62bcaa0abfc`
— `0x12` = sha2-256, `0x20` = 32-byte digest, and the digest matches the
sha2-256 above. Step 3 passes.

Reproduce in one line:

```bash
curl -sL "https://dweb.link/ipfs/QmQbnTEh2FHct49adwcLc6U5qQqEGvwXpzSBQ8A5FSsmKR?format=raw" | sha256sum
# 2197d77bcc86b685c18297a231f45be91b0729e37d2f97a6da70f62bcaa0abfc
```

## Step 4 — metadata consistency (chain-as-manifest)

Top Shot does not expose `metadata_cid` on chain. Under SPEC v0.2 §4 this
triggers the "chain-as-manifest" case: every field that would have appeared
in an off-chain manifest (`edition_id`, `serial`, `edition_size`,
`media_cid`) came directly from chain-state in step 1 and passed steps 2–3,
so step 4 reduces to an internal consistency check. The adapter emits
`metadata_cid: null` in the envelope to make this explicit.

## Result

```json
{
  "spec_version": "0.2",
  "result": "conforming",
  "fields": {
    "chain": "flow-mainnet",
    "contract": "A.0b2a3299cc857e29.TopShot",
    "token_id": "40105574",
    "edition_id": "90",
    "serial": 1112,
    "edition_size": 16000,
    "holder": "0x0bb3b2a249ca6822",
    "media_cid": "QmQbnTEh2FHct49adwcLc6U5qQqEGvwXpzSBQ8A5FSsmKR",
    "media_type": "VIDEO_SQUARE",
    "metadata_cid": null
  },
  "steps": [
    {"step": 1, "name": "read_chain_fields",   "ok": true},
    {"step": 2, "name": "serial_in_range",     "ok": true},
    {"step": 3, "name": "media_cid_hash",      "ok": true},
    {"step": 4, "name": "metadata_consistent", "ok": true}
  ],
  "failed_step": null
}
```

The conformance harness at `/conformance/` encodes this example as the
vector `flow-topshot-pass-1`, with the full Flow REST response and the raw
IPFS block recorded under `/conformance/fixtures/flow-topshot-pass-1/`. A
third party can run `node conformance/run.js adapters/flow-topshot/verify.js`
and see all three Flow vectors (pass + step-2 synthetic failure + step-3
synthetic failure) round-trip offline, then re-run with `OPO_LIVE=1` to
replay against mainnet.

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
