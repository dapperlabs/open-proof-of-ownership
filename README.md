# open-proof-of-ownership

A reference specification and implementation for **independently verifying**
that a digital collectible — identified by an on-chain token — corresponds to
a specific media artifact and a specific holder account, using only public
chain-state and public content-addressed retrieval.

No issuer API. No private indexer. No trust assumption beyond chain
consensus and the CID hash function.

## Status

- `SPEC.md` — v0.6 draft. CC0. Changelog at the top of the file.
- `/conformance/` — JSON test vectors + recorded mainnet fixtures. CC0.
- `/adapters/flow-topshot/` — reference adapter, MIT. All three Flow vectors
  round-trip offline against fixtures and live against Flow mainnet + dweb.link.
- `/adapters/erc721-generic/` — reference adapter, MIT. Seven ERC-721 vectors
  across TWO independent contracts:
  - Azuki #9999 (CIDv0 baseURI, dag-pb metadata leaf, UnixFS-inline image):
    pass + image-tampered fail + two-gateway cross-check pass + cross-check
    mismatch fail.
  - Pudgy Penguins #1 (CIDv1 base32 baseURI, raw-codec metadata leaf,
    chunked-file image root, two-segment path): pass + cross-check pass +
    image-tampered fail.
  All seven round-trip offline; live mode verifies each pass vector against
  Ethereum mainnet + gateway.pinata.cloud (primary) + ipfs.io (cross-check
  secondary, HEAD). The two collections together satisfy SPEC §7.1
  generic-adapter coverage on all three encoding axes.
- `/adapters/tezos-fa2/` — reference adapter, MIT. Three Tezos vectors on
  fxhash gentk v1 (`KT1KEa8z…`) against native Tezos L1 RPC
  (`mainnet.api.tez.ie`, no indexer). Exercises the SPEC §4 step 1
  **confirmed-holder** branch: FA2's ledger is indexed by
  `(address, token_id)` and has no `ownerOf(token_id)` primitive, so a
  claimed holder MUST be input and confirmed against the ledger. The
  adapter implements Michelson PACK + blake2b-256 + base58check locally
  to compute `script_expr_hash` without trusting any indexer for the
  key-hash binding. Three chain families (Flow, EVM, Tezos) together
  satisfy SPEC §7.2 cross-chain coverage on all three model axes.
- Live Example 1: [topshot-auth-portal.vercel.app](https://topshot-auth-portal.vercel.app)
  — verifies `A.0b2a3299cc857e29.TopShot` on Flow mainnet under this spec.

## What this is

A pattern, not a platform. The spec is one short document. The adapters are
small enough to read in an afternoon. Fork it, rename it, ignore it — the
license permits all three.

## What this is not

- A rights/royalty registry.
- A custody system.
- A marketplace, indexer, or display layer.
- A claim about the legal status of any underlying asset.

## Quick start (verifier)

```bash
# Verify one live Flow Top Shot Moment against mainnet + dweb.link
node adapters/flow-topshot/verify.js \
  --token-id 40105574 \
  --holder 0x0bb3b2a249ca6822

# Verify one live Azuki (ERC-721, CIDv0) token against Ethereum mainnet + gateway.pinata.cloud
node adapters/erc721-generic/verify.js \
  --contract 0xED5AF388653567Af2F388E6224dC7C4b3241C544 \
  --token-id 9999

# Verify one live Pudgy Penguins (ERC-721, CIDv1) token against the same infrastructure
node adapters/erc721-generic/verify.js \
  --contract 0xBd3531dA5CF5857e7CfAA92426877b022e612cf8 \
  --token-id 1

# Same tokens with the two-gateway cross-check active (gateway.pinata.cloud + ipfs.io)
OPO_IPFS_CROSSCHECK=1 node adapters/erc721-generic/verify.js \
  --contract 0xED5AF388653567Af2F388E6224dC7C4b3241C544 \
  --token-id 9999

# Verify one live Tezos fxhash gentk token against mainnet Tezos L1 RPC + IPFS
node adapters/tezos-fa2/verify.js \
  --contract KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE \
  --token-id 1 \
  --holder tz1PoDdN2oyRyF6DA73zTWAWYhNL4UGr3Egj
```

All three adapters print the same step-envelope shape:

```json
{
  "spec_version": "0.6",
  "result": "conforming",
  "fields": { "chain": "...", "holder": "...", "media_cid": "...", "metadata_cid": "...", ... },
  "steps": [
    {"step": 1, "name": "read_chain_fields", "ok": true},
    {"step": 2, "name": "serial_in_range",  "ok": true},
    {"step": 3, "name": "media_cid_hash",   "ok": true},
    {"step": 4, "name": "metadata_consistent", "ok": true}
  ],
  "failed_step": null
}
```

## Conformance

An implementation is **conforming** if it produces the expected
`result` and `failed_step` for every entry in `conformance/vectors.json`.

```bash
# Offline — every network call is served from conformance/fixtures/.
# No RPC, no gateway, no flaky tests. Reproducible by anyone with Node 18+.
node conformance/run.js adapters/flow-topshot/verify.js
node conformance/run.js adapters/erc721-generic/verify.js
node conformance/run.js adapters/tezos-fa2/verify.js

# Live — replay each vector against the live chain + a public IPFS gateway.
OPO_LIVE=1 node conformance/run.js adapters/flow-topshot/verify.js
OPO_LIVE=1 node conformance/run.js adapters/erc721-generic/verify.js
OPO_LIVE=1 node conformance/run.js adapters/tezos-fa2/verify.js
```

Expected offline output:

```
harness=OFFLINE  adapter=flow-topshot  vectors=3

PASS: flow-topshot-pass-1
PASS: flow-topshot-fail-step2-serial-out-of-range
PASS: flow-topshot-fail-step3-cid-tampered

harness=OFFLINE  adapter=erc721-generic  vectors=7

PASS: erc721-azuki-9999-pass
PASS: erc721-azuki-9999-fail-step3-image-tampered
PASS: erc721-azuki-9999-pass-crosscheck
PASS: erc721-pudgy-1-pass
PASS: erc721-pudgy-1-pass-crosscheck
PASS: erc721-pudgy-1-fail-step3-image-tampered
PASS: erc721-azuki-9999-fail-crosscheck-mismatch

harness=OFFLINE  adapter=tezos-fa2  vectors=3

PASS: tezos-fxhash-gentk-1-pass
PASS: tezos-fxhash-gentk-1-fail-step1-wrong-holder
PASS: tezos-fxhash-gentk-1-fail-step3-metadata-tampered
```

## Repository layout

```
SPEC.md                      ← the specification (CC0)
LICENSE                      ← MIT (code)
LICENSE-SPEC                 ← CC0 (spec + vectors)
conformance/
  vectors.json               ← test inputs + expected results
  run.js                     ← test harness
adapters/
  flow-topshot/              ← Flow + Cadence reference adapter
  erc721-generic/            ← EVM + ERC-721 reference adapter
  tezos-fa2/                 ← Tezos + FA2 (single-edition) reference adapter
examples/
  example-1-topshot.md       ← walks through one verified Top Shot Moment
```

## Why publish this

A verification methodology that lives only inside one company's portal is
indistinguishable from marketing. Published as a chromeless spec under CC0,
with working code under MIT and a live reference instance, it becomes
something a peer project, a journalist, or a regulator can fork, cite, or
attack on its merits. That is the point of this repo.

## Related work

- **W3C Verifiable Credentials Data Model 2.0** — adjacent: claim-issuer
  model, not asset/holder model.
- **ERC-721 / ERC-1155** — the substrate this spec verifies on EVM chains.
- **Flow NFT Metadata Standard (FLIP-0636)** — the substrate on Flow.
- **Etherscan, Flowscan, Flowdiver** — explorer-class precedents for the
  reference-tool register adopted here.

## Contributing

Open an issue describing the chain or contract you want to support. Adapter
PRs MUST include a conformance entry covering at least one passing and one
failing token under that adapter.

## License

- Code: MIT (see `LICENSE`).
- Specification + conformance vectors: CC0 (see `LICENSE-SPEC`).
