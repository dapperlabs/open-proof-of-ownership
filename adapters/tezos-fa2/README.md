# adapters/tezos-fa2

OPO reference adapter for Tezos FA2 (TZIP-12) single-edition (NFT
profile) contracts. Verifies ownership of a token held under a
contract whose `token_metadata` big-map value contains an `ipfs://`
URI.

## Trust model

The adapter reads exclusively from a Tezos L1 RPC (default
`mainnet.api.tez.ie`, ECAD Labs) and a non-issuer IPFS gateway
(default `gateway.pinata.cloud`). **No indexer is called.** tzkt.io,
Blockwatch, Subsquid, dipdup — none. The adapter computes
Michelson `script_expr_hash` values locally (PACK → blake2b-256 →
base58check with `expr` prefix), so the RPC is trusted only for the
value at a given (big-map-pointer, key-hash) tuple; the key-hash
binding itself is derived client-side from the user-supplied
address and token_id.

## Spec branch

This adapter implements the **confirmed-holder branch** of SPEC §4
step 1. FA2's `ledger : (address, nat) -> nat` does not expose a
`ownerOf(token_id)` primitive, and scanning the full ledger is
infeasible without an indexer. The adapter therefore accepts
`holder` as input and confirms a non-zero balance at
`(holder, token_id)`.

Downstream consumers should understand that a successful result
establishes:

> The claimed holder holds a non-zero balance of this token_id
> under this contract, AND the token's chain-pinned metadata
> manifest plus its referenced media resolve to bytes that hash
> correctly to the declared CIDs.

For single-edition FA2 profiles (TZIP-12's "NFT" profile; fxhash
gentk v1's effective invariant), the non-zero balance collapses to
"the claimed holder is the sole holder," but this is a
PROFILE-CONSTRAINED claim, not a chain-wide invariant (see SPEC
§5.3). Adapters reusing this code for non-1/1 FA2 contracts MUST
override `edition_size` and the uniqueness claim.

## Big-map pointers

The `CONTRACT_BIGMAPS` table in `verify.js` ships pointers for
`KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE` (fxhash gentk v1). Adding a
new contract requires:

1. Fetch `/chains/main/blocks/head/context/contracts/{addr}/script`
   from any Tezos L1 RPC.
2. Find the big-map IDs in the storage expression by path
   annotation (`ledger`, `token_metadata`). Node:
   `api.tzkt.io/v1/contracts/{addr}/bigmaps` exposes the same
   mapping keyed by `path` and is a convenient (indexer-cached)
   lookup surface; the binding itself is chain-anchored and the
   adapter does NOT call tzkt at verification time.
3. Record the IDs and the contract's expected value-type shape.
4. Add a fresh conformance vector that exercises the new contract
   end-to-end.

The pointer table is intentionally a hard-coded list rather than a
runtime read: the pointer IDs are immutable per contract (set at
origination), and a verifier should not re-derive them on every
call. If the contract migrates, that requires a new big-map ID and
— by OPO convention — a new adapter config entry.

## Live usage

```sh
node adapters/tezos-fa2/verify.js \
  --contract KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE \
  --token-id 1 \
  --holder tz1PoDdN2oyRyF6DA73zTWAWYhNL4UGr3Egj
```

Environment variables:

- `OPO_TEZOS_RPC` — Tezos L1 RPC (default `https://mainnet.api.tez.ie`).
  Any public Tezos RPC works; tzkt's RPC proxy at
  `rpc.tzkt.io/mainnet` is equivalent for our read paths.
- `OPO_IPFS_GW` — trustless IPFS gateway (default
  `https://gateway.pinata.cloud/ipfs/`).

## Conformance

```sh
node       conformance/run.js adapters/tezos-fa2/verify.js  # offline
OPO_LIVE=1 node conformance/run.js adapters/tezos-fa2/verify.js  # mainnet
```

Three vectors:

- `tezos-fxhash-gentk-1-pass` — fxhash gentk #1 at
  `tz1PoDdN…`. Exercises the full happy path (ledger confirmation
  + token_metadata lookup + two IPFS CIDv0 blocks).
- `tezos-fxhash-gentk-1-fail-step1-wrong-holder` — burn address
  (`tz1burnburn…`) with no balance. Confirms step 1 fails cleanly
  on a 404 from the ledger RPC.
- `tezos-fxhash-gentk-1-fail-step3-metadata-tampered` —
  manifest bytes with a trailing 0xFF byte. Confirms step 3
  catches byte-level substitution against the CIDv0 multihash.

## Primitives implemented from scratch

- `blake2b(input, outlen)` — RFC 7693, variable output length.
  Node's `crypto.createHash("blake2b512")` is fixed-length 64 and
  cannot be reconfigured via `outputLength`; script_expr_hash
  needs a 32-byte digest and the parameter block for `outlen=32`
  alters the initial `h[0]` state, so simple truncation of
  blake2b-512 is NOT equivalent.
- `b58check{Encode,Decode}` — standard base58check with
  prefix-byte support (for tz1/tz2/tz3/KT1/expr).
- `pack{Nat,AddressValue,PairAddrNat}` — Tezos Michelson PACK
  binary encoding for the subset needed by FA2 big-map key
  derivation.
- `scriptExprHash(packed_bytes)` — Tezos script expression hash
  (PACK → blake2b-256 → base58check with `expr` prefix
  `0d2c401b`). Verified against TzKT's `hash` field for known
  big-map entries.
