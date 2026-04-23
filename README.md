# open-proof-of-ownership

A reference specification and implementation for **independently verifying**
that a digital collectible — identified by an on-chain token — corresponds to
a specific media artifact and a specific holder account, using only public
chain-state and public content-addressed retrieval.

No issuer API. No private indexer. No trust assumption beyond chain
consensus and the CID hash function.

## Status

- `SPEC.md` — v0.2 draft. CC0. Changelog at the top of the file.
- `/conformance/` — JSON test vectors + recorded mainnet fixtures. CC0.
- `/adapters/flow-topshot/` — reference adapter, MIT. All three Flow vectors
  round-trip offline against fixtures and live against Flow mainnet + dweb.link.
- `/adapters/erc721-generic/` — reference adapter, MIT. Live-only; fixtures
  are iter-4 scope.
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

# Verify one ERC-721 token end-to-end
node adapters/erc721-generic/verify.js \
  --rpc https://cloudflare-eth.com \
  --contract 0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb \
  --token-id 100
```

Both adapters print the same five-step result envelope:

```json
{
  "spec_version": "0.2",
  "result": "conforming",
  "fields": { "chain": "...", "holder": "...", "media_cid": "...", ... },
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

# Live — replay each vector against Flow mainnet + dweb.link.
OPO_LIVE=1 node conformance/run.js adapters/flow-topshot/verify.js

# ERC-721 is currently live-only (fixtures: iter-4 scope).
OPO_LIVE=1 node conformance/run.js adapters/erc721-generic/verify.js
```

Expected offline output for the Flow adapter:

```
harness=OFFLINE  adapter=flow-topshot  vectors=3

PASS: flow-topshot-pass-1
PASS: flow-topshot-fail-step2-serial-out-of-range
PASS: flow-topshot-fail-step3-cid-tampered
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
