# OPO adapter — Flow + Top Shot

Reference adapter binding [SPEC.md](../../SPEC.md) §3 fields to Flow mainnet
reads against `A.0b2a3299cc857e29.TopShot`.

## Files

- `verify.js` — five-step verification per SPEC §4.
- `cadence/getMomentMetadata.cdc` — read-only Cadence script returning the
  required field set for one held Moment.
- `package.json` — Node 18+ dependencies (sole runtime dep is `minimist` for
  CLI; verification logic uses built-in `fetch` + `crypto`).

## Field bindings

| OPO field | Source | Notes |
|---|---|---|
| `chain` | configuration | `flow-mainnet` |
| `contract` | configuration | `A.0b2a3299cc857e29.TopShot` |
| `token_id` | Cadence input | `UInt64` Moment ID |
| `edition_id` | `nft.data.setID` | Top Shot edition is `setID + playID`; this adapter exposes `setID` and includes `playID` in the metadata join |
| `serial` | `nft.data.serialNumber` | `UInt32` |
| `edition_size` | `TopShot.getNumMomentsInEdition(setID, playID)` | May be 0 for editions still minting |
| `holder` | input account address | Verifier MUST cross-reference holder via collection iteration if input doesn't include holder |
| `media_cid` | `MetadataViews.Display.thumbnail` (IPFSFile) | Pre-migration editions return empty until Layer-5 migration completes |
| `metadata_cid` | `MetadataViews.Edition` reference where exposed | Optional under spec; required by step 4 |

## Trust assumptions

- Flow mainnet consensus.
- `rest-mainnet.onflow.org` reachability (verifier MAY substitute any public
  Flow REST endpoint, including a self-hosted access node).
- IPFS gateway reachability for the configured `OPO_IPFS_GW` (default
  `dweb.link`, NOT operated by Dapper).

## Out-of-scope (matches SPEC §6 + portal "honest limits")

- Floor price, last-sale, market depth.
- Top Shot Score, challenge progress, set-completion badges, full-team bonus.
- Showcase arrangement, custodial username↔address mapping.
- Pre-migration edition CID binding (waits on Layer-5 migration).

## Run

```bash
npm install
node verify.js --token-id 1234567 --contract A.0b2a3299cc857e29.TopShot
```
