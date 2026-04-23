# OPO adapter — generic ERC-721

Reference adapter binding [SPEC.md](../../SPEC.md) §3 fields to a public EVM
RPC and an ERC-721 contract that exposes ERC-721 Metadata + (ideally)
ERC-721Enumerable.

## Field bindings

| OPO field | Source | Notes |
|---|---|---|
| `chain` | configuration | e.g. `ethereum-mainnet`, `base-mainnet` |
| `contract` | configuration | 0x… |
| `token_id` | input | decimal string of `uint256` |
| `edition_id` | `contract` | default: single-edition contracts treat the contract as the edition |
| `serial` | `tokenId` | default: 1-indexed; adapters MAY override |
| `edition_size` | `totalSupply()` | requires ERC-721Enumerable; absent → adapter emits failed_step=1 |
| `holder` | `ownerOf(tokenId)` | |
| `media_cid` | `image` field of metadata JSON | MUST be an `ipfs://` URI |
| `metadata_cid` | `tokenURI(tokenId)` | MUST be an `ipfs://` URI |

## Non-conforming cases

A contract is **not conforming** under this adapter if any of the following
hold — adapters MUST surface the failed step rather than synthesize a value:

- `tokenURI` is `data:` / `https:` / non-IPFS — fails step 1 (no `metadata_cid`).
- Metadata JSON `image` is non-IPFS — fails step 3.
- Contract does not implement ERC-721Enumerable AND does not expose
  `MAX_SUPPLY` — fails step 1 (no `edition_size`).
- Image bytes do not hash to declared CID — fails step 3.

## Trust assumptions

- EVM consensus of the configured chain.
- The configured `--rpc` endpoint (verifier MAY rotate / use multiple).
- IPFS gateway reachability for `OPO_IPFS_GW` (default `dweb.link`).

## Run

```bash
npm install
node verify.js --rpc https://eth.llamarpc.com \
  --contract 0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb \
  --token-id 100
```
