# OPO adapter — solana-metaplex

Reference implementation of the Open Proof-of-Ownership specification
(v0.7) for Solana NFTs stored under **SPL Token + Metaplex Token
Metadata v1**, with **Arweave** as the off-chain media layer.

License: MIT (code). Spec it implements is CC0.

## Scope

Bound to the single-edition (1/1) profile of Metaplex Token Metadata:

- SPL Token mint with `decimals == 0` and `supply == 1`
- Metaplex Token Metadata v1 account (PDA) keyed by the mint
- Off-chain manifest JSON hosted on Arweave (`https://arweave.net/<tx_id>`
  or `ar://<tx_id>`)
- Image resolved from the manifest's `image` (or
  `properties.files[0].uri`), also hosted on Arweave

This adapter is **not** generic across Metaplex variants (pNFT, core,
compressed cNFTs, fungible SPL Token-2022) — it covers the Metadata v1
path that represents the majority of historical Solana NFT issuance.

## Commitment model (SPEC §5.4)

`commitment_type = "arweave-tx-id"`.

Unlike IPFS CIDs, an Arweave `tx_id` is **not** the content hash of the
served bytes. It is the hash of an RSA-PSS signature over the canonical
encoding of the transaction fields — one of which is `data_root`, the
merkle root of the transaction's data chunks. Reconstructing the
commitment client-side therefore requires access to:

1. `data_root` (inside the tx envelope)
2. The precise Arweave chunk-merkle tree (implemented per the Arweave
   data-chunks spec)

As of 2026-04, **public Arweave gateway CDNs (arweave.net) do not
universally serve `/tx/<id>` for envelope access** — it returns 404.
Peer-node RPC (`https://<node-ip>:1984/tx/<id>`) does expose it, but
querying raw peer nodes is brittle and out of scope for a reference
adapter that runs from a standard HTTPS client.

This adapter therefore implements a **weaker** step-3 integrity check
(SPEC §5.4):

- Fetch the raw bytes from `https://arweave.net/raw/<tx_id>`.
- Query `https://arweave.net/graphql` for the tx envelope fields
  `data.size` and `tags[Content-Type]`.
- Assert `bytes.length === data.size` and Content-Type is appropriate
  (`application/json` for metadata, `image/*` for media).
- An attacker attempting to substitute bytes under this commitment
  model must compromise **both** the raw-byte CDN AND the GraphQL
  index (and arrange them to tell the same consistent lie about
  `data.size`) — which is strictly more work than a single
  content-hash spoof on an IPFS gateway, but strictly less than
  reconstructing the `data_root` locally would require. This
  asymmetry is normatively documented in SPEC §5.4.

A future version of this adapter that reconstructs `data_root` locally
per the Arweave chunk-merkle spec would upgrade step-3 to equivalent
cryptographic strength as the IPFS adapters, **without** changing the
adapter's external interface — the result envelope is already
spec-forwards-compatible.

## Metaplex metadata PDA table

The Metaplex metadata account for a given mint is a Program-Derived
Address (PDA):

```
PDA = findProgramAddressSync(
  [
    "metadata",
    PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    mint,
  ],
  PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
)
```

Deriving a PDA requires an ed25519 curve-off-point check (to find the
highest bump whose candidate address is NOT a valid curve point). Rather
than ship a ~150-line pure-JS ed25519 implementation just to compute a
one-time-per-mint constant, this adapter maintains a small table
(`MINT_METADATA_PDAS` in `verify.js`) of pre-derived PDAs. A verifier
MAY re-derive any entry independently using any Solana SDK (e.g.
`@solana/web3.js`'s `PublicKey.findProgramAddressSync`) and compare.

This parallels the Tezos FA2 adapter's per-contract big-map pointer
table.

Currently configured mints:

| Mint | Metadata PDA | Bump | Collection |
|---|---|---|---|
| `3saAedkM9o5g1u5DCqsuMZuC4GRqPB4TuMkvSsSVvGQ3` | `9ap4ycBoX18mc7AZ54hfLghZmaADpbL94BvL6DTU6QqQ` | 255 | Okay Bears (collection parent NFT) |

To extend this adapter to a new mint:

```
node -e "
const {PublicKey} = require('@solana/web3.js');
const M = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const mint = new PublicKey('<YOUR_MINT>');
const [pda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('metadata'), M.toBuffer(), mint.toBuffer()], M);
console.log(pda.toBase58(), bump);"
```

## Usage (live)

```
node adapters/solana-metaplex/verify.js \
  --contract 3saAedkM9o5g1u5DCqsuMZuC4GRqPB4TuMkvSsSVvGQ3 \
  --holder   4s1BwwyHVnRi9aJaHGKRN15hjKRLCDVkYcDYtAKX4EEs
```

Defaults:

- Solana RPC: `https://solana-rpc.publicnode.com` (public, no key)
- Arweave raw gateway: `https://arweave.net/raw/<tx_id>`
- Arweave GraphQL: `https://arweave.net/graphql`

Override via `OPO_SOLANA_RPC`, `OPO_ARWEAVE`, `OPO_ARWEAVE_GQL`
environment variables.

## Conformance (offline)

```
node conformance/run.js adapters/solana-metaplex/verify.js
```

Three fixtures exercise:

- `solana-okaybears-collection-pass` — full chain + arweave pass.
- `solana-okaybears-collection-fail-step1-wrong-holder` — chain reads
  succeed but the claimed holder is the Solana burn address,
  mismatching the chain-derived holder; fails step 1.
- `solana-okaybears-collection-fail-step3-image-tampered` — image bytes
  have a single 0xFF byte appended, disagreeing with the Arweave
  GraphQL-advertised `data.size`; fails step 3. Demonstrates that the
  weaker §5.4 integrity check still catches byte-level append/truncate
  attacks.

## No dependencies

Runtime deps beyond Node 18+ stdlib: `minimist` (CLI arg parsing only).
All decoders (base58, SPL mint, SPL token account, Metaplex Metadata
v1 Borsh prefix, Arweave URI regex) are pure JS in `verify.js`. See
`_internals` exports for direct testing.
