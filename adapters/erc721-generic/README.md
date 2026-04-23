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

### Two-gateway cross-check (OPTIONAL, SPEC §4 step 3)

Set `OPO_IPFS_CROSSCHECK=1` (or pass `crosscheck: true` in `verify()`
opts) to require that an independent second gateway advertises the same
leaf CID for the same `<dirCID>/<path>`. The default second gateway is
`https://ipfs.io/ipfs/` (Interplanetary Shipyard), independent of the
default primary `https://gateway.pinata.cloud/ipfs/` (Pinata Cloud,
Inc.). Override via `OPO_IPFS_GW_2`. The secondary is probed with
`HEAD` — the cross-check only needs the leaf CID advertised in
`x-ipfs-roots` or the ETag, not the raw bytes (the bytes-to-CID hash
check runs against the primary). A disagreement between the two
gateways fails step 3 with a `crosscheck mismatch` error. Agreement
weakens the single-gateway traversal-correctness assumption to a
collusion-between-two-operators assumption.

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
- IPFS gateway reachability for `OPO_IPFS_GW` (default
  `gateway.pinata.cloud`). The gateway's UnixFS path resolution is trusted
  only to the extent described in SPEC §5 — any byte tamper is still
  detected against the returned leaf CID. When `OPO_IPFS_CROSSCHECK=1` is
  set, a second gateway (`OPO_IPFS_GW_2`, default `ipfs.io`) is consulted
  via HEAD and the two leaf CIDs MUST agree.

## Live invocation

```bash
node verify.js \
  --contract 0xED5AF388653567Af2F388E6224dC7C4b3241C544 \
  --token-id 9999
```

Override RPC and gateway with `OPO_ETH_RPC` and `OPO_IPFS_GW`.

## Fixtures

Seven vectors across two independent contracts. Together they satisfy
SPEC §7.1 generic-adapter coverage on all three encoding axes — baseURI
CID version, metadata leaf codec, image payload layout.

### Azuki — `0xED5AF388653567Af2F388E6224dC7C4b3241C544`

Encoding signature: CIDv0 baseURI · dag-pb (UnixFS-inline) metadata leaf ·
UnixFS-inline image root.

- `conformance/fixtures/erc721-azuki-9999-pass/` — real mainnet capture for
  Azuki #9999 (holder `0x4b0207e11661e41b091697980b3d49bd59358d7c`,
  edition_size 10000). Metadata leaf CID
  `Qme4i1jbJvY8mfDWfFXLKh1ZLy1WtKh4edHXdFWfA61Fps` (CIDv0, 763 bytes).
  Image root CID `QmfQbRhnw6jLPyqf9zDmT6nMbAwZzfHh26XKdKN3cka6Kr` (CIDv0,
  152 bytes — root of a 3-chunk dag-pb tree over the 703,155-byte PNG;
  the root hash binds the full Merkle tree).
- `conformance/fixtures/erc721-azuki-9999-fail-step3/` — same fixture with
  one trailing `0xFF` byte appended to the image root block, synthesizing a
  step-3 failure.
- `conformance/fixtures/erc721-azuki-9999-pass-crosscheck/` — pass fixture
  extended with `path-map-2.json` capturing the independent second
  gateway's `x-ipfs-roots` response (via HEAD). Both gateways advertise
  identical leaf CIDs; cross-check passes.
- `conformance/fixtures/erc721-azuki-9999-fail-crosscheck-mismatch/` —
  synthetic fixture where the second gateway returns a different leaf
  CID. Models a primary-gateway substitution attack caught by the
  independent secondary.

### Pudgy Penguins — `0xBd3531dA5CF5857e7CfAA92426877b022e612cf8`

Encoding signature: **CIDv1 base32 baseURI** · **raw-codec (0x55)
metadata leaf** · **chunked-file image root** · **two-segment image path**.

- `conformance/fixtures/erc721-pudgy-1-pass/` — real mainnet capture for
  Pudgy Penguins #1 (holder `0xcce98763ff5a9ff5baf8b15abc456077a1e84f2a`,
  edition_size 8888). baseURI is `ipfs://bafybeibc5sgo2plmjkq2tzmhrn54bk3crhnc23zd2msg4ea7a4pxrkgfna/`
  (CIDv1). Metadata leaf CID
  `bafkreiclss3ogjk7tpqui5x6a3whluqjo7z6p6ndid5sn34si23koptvlu` (CIDv1
  raw codec 0x55, 592 bytes — the bytes ARE the JSON, no UnixFS header).
  Image ref `ipfs://QmNf1.../penguin/1.png` uses a two-segment path.
  Image root CID `Qma6fcCGEJcVYd4DUHVQ5akPLhA5REWLKTMTnPCaxiAEtd` (CIDv0,
  104 bytes — the root of a chunked dag-pb tree; the root-block bytes
  carry links to child-block CIDs, the PNG bytes themselves live in
  linked sub-blocks the verifier does not need to fetch, because each
  link is a sha2-256 digest that the root's CID cryptographically binds).
- `conformance/fixtures/erc721-pudgy-1-pass-crosscheck/` — pass fixture
  extended with `path-map-2.json` capturing ipfs.io's HEAD response for
  both directory paths (probed live 2026-04-23). Both gateways agree on
  leaf CIDs; cross-check passes.
- `conformance/fixtures/erc721-pudgy-1-fail-step3/` — pass fixture with
  one `0xFF` byte appended to the image root block. sha256 no longer
  matches the CIDv0 multihash digest; step 3 fails. This is the dag-pb
  chunked-root analogue of the Azuki inline-UnixFS fail vector.
