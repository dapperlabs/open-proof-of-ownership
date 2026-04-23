# OPO adapter — generic ERC-721

Reference adapter binding [SPEC.md](../../SPEC.md) §3 fields to a public EVM
RPC and an ERC-721 contract that exposes ERC-721 Metadata + ERC-721Enumerable.

## Field bindings

| OPO field | Source | Notes |
|---|---|---|
| `chain` | configuration | e.g. `ethereum-mainnet`, `base-mainnet` |
| `contract` | configuration | 0x… |
| `token_id` | input | decimal string of `uint256` |
| `edition_id` | `contract` | default: single-edition contracts treat the contract as the edition |
| `serial` | `tokenId` | default: 1-indexed; adapters MAY override |
| `edition_size` | `totalSupply()` | requires ERC-721Enumerable; absent → adapter emits `failed_step=1` |
| `holder` | `ownerOf(tokenId)` | |
| `metadata_cid` | leaf CID resolved from `tokenURI(tokenId)` | direct CID ref OR directory-path ref per SPEC §4 step 3 |
| `media_cid` | leaf CID resolved from metadata `image`/`image_url` | same |

## Path-resolved retrieval

Most ERC-721 collections set a `baseURI` and return
`tokenURI(n) = baseURI + tokenId` — so the chain-pinned reference is
`ipfs://<dirCID>/<tokenId>`, not a bare per-token CID. This adapter handles
that case (SPEC §4 step 3):

1. GET `/ipfs/<dirCID>/<tokenId>?format=raw` with
   `Accept: application/vnd.ipld.raw` at a non-issuer gateway.
2. Read the leaf CID from `x-ipfs-roots` (last entry) or the ETag
   (`"<cid>.raw"`).
3. Compute `sha2-256` of the returned raw bytes and confirm equality with
   the multihash digest decoded from the leaf CID.
4. Report the **leaf CID** as `metadata_cid` / `media_cid` — never the
   declared directory CID.

This preserves content-addressed integrity (any byte tamper fails step 3)
while adding one documented trust assumption: the gateway performs UnixFS
directory traversal correctly.

### Two-gateway cross-check (OPTIONAL, SPEC v0.4 §4 step 3)

Set `OPO_IPFS_CROSSCHECK=1` (or pass `crosscheck: true` in `verify()`
opts) to require that an independent second gateway advertises the same
leaf CID for the same `<dirCID>/<path>`. The default second gateway is
`https://ipfs.io/ipfs/` (Interplanetary Shipyard), independent of the
default primary `https://dweb.link/ipfs/` (Protocol Labs). Override via
`OPO_IPFS_GW_2`. A disagreement between the two gateways fails step 3
with a `crosscheck mismatch` error. Agreement weakens the single-gateway
traversal-correctness assumption to a collusion-between-two-operators
assumption.

## Non-conforming cases

A contract is **not conforming** under this adapter if any of the following
hold — the adapter surfaces the failed step rather than synthesize a value:

- `tokenURI` is `data:` / `https:` / non-IPFS — fails step 1 (no CID).
- Metadata JSON `image` is non-IPFS — fails step 3.
- Contract does not implement ERC-721Enumerable AND does not expose an
  equivalent supply binding — fails step 1.
- Image bytes do not hash to declared leaf CID — fails step 3.

## Trust assumptions

- EVM consensus of the configured chain.
- The configured RPC endpoint (`OPO_ETH_RPC`, default
  `https://ethereum-rpc.publicnode.com`). Verifier MAY rotate across
  multiple RPCs and require agreement.
- IPFS gateway reachability for `OPO_IPFS_GW` (default `dweb.link`). The
  gateway's UnixFS path resolution is trusted only to the extent described
  in SPEC §5 — any byte tamper is still detected against the returned
  leaf CID. When `OPO_IPFS_CROSSCHECK=1` is set, a second gateway
  (`OPO_IPFS_GW_2`, default `ipfs.io`) is consulted and the two leaf
  CIDs MUST agree.

## Live invocation

```bash
node verify.js \
  --contract 0xED5AF388653567Af2F388E6224dC7C4b3241C544 \
  --token-id 9999
```

Override RPC and gateway with `OPO_ETH_RPC` and `OPO_IPFS_GW`.

## Fixtures

- `conformance/fixtures/erc721-azuki-9999-pass/` — real mainnet capture for
  Azuki #9999 (contract `0xED5AF388653567Af2F388E6224dC7C4b3241C544`,
  holder `0x4b0207e11661e41b091697980b3d49bd59358d7c`, edition_size 10000).
  Metadata leaf CID `Qme4i1jbJvY8mfDWfFXLKh1ZLy1WtKh4edHXdFWfA61Fps`
  (CIDv0, 763 bytes). Image root CID
  `QmfQbRhnw6jLPyqf9zDmT6nMbAwZzfHh26XKdKN3cka6Kr` (CIDv0, 152 bytes — the
  root of a 3-chunk dag-pb tree over the 703,155-byte PNG; the root hash
  binds the full Merkle tree).
- `conformance/fixtures/erc721-azuki-9999-fail-step3/` — same fixture with
  one trailing `0xFF` byte appended to the image root block, synthesizing a
  step-3 failure.
- `conformance/fixtures/erc721-azuki-9999-pass-crosscheck/` — pass fixture
  extended with `path-map-2.json` capturing the independent ipfs.io gateway's
  `x-ipfs-roots` response for the same two directory paths (probed live
  2026-04-23). Both gateways advertise identical leaf CIDs; the cross-check
  passes.
- `conformance/fixtures/erc721-azuki-9999-fail-crosscheck-mismatch/` —
  pass fixture extended with a synthetic `path-map-2.json` where the
  second gateway returns a different leaf CID for the tokenURI directory
  path. Models a substitution attack where a compromised primary gateway
  substitutes a different leaf CID; the independent second gateway
  disagrees, and the verifier fails step 3 with `crosscheck mismatch`.
