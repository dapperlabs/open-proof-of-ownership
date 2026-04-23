# OPO adapter — Flow + Top Shot

Reference adapter binding [SPEC.md](../../SPEC.md) §3 fields to Flow mainnet
reads against `A.0b2a3299cc857e29.TopShot`.

## Files

- `verify.js` — five-step verification per SPEC §4. Pure Node 18+ (`fetch`,
  `crypto`, `fs`). One runtime dep (`minimist`) used only by the CLI entry.
- `cadence/getMomentMetadata.cdc` — read-only Cadence script returning
  `MomentFields { editionID, playID, serial, editionSize, holder, mediaCIDs[] }`
  for one Moment at one holder.
- `package.json` — package metadata.

## Field bindings (SPEC v0.2 §3)

| OPO field | Source | Notes |
|---|---|---|
| `chain` | configuration | `flow-mainnet` |
| `contract` | configuration | `A.0b2a3299cc857e29.TopShot` |
| `token_id` | Cadence input | `UInt64` Moment ID |
| `edition_id` | `nft.data.setID` | Top Shot's edition identity is the (setID, playID) pair; the script returns both, the adapter binds `edition_id` to `setID` |
| `serial` | `nft.data.serialNumber` | `UInt32`, 1-indexed |
| `edition_size` | `TopShot.getNumMomentsInEdition(setID, playID)` | 0 for editions still minting — adapter emits step-1 failure in that case |
| `holder` | caller-supplied Address | The Cadence `borrowMoment(id)` panics if the Moment is not held at that Address, so a successful script run proves holder binding at the read block |
| `media_cid` | first `IPFSFile` entry in `MetadataViews.Medias` | Ordered by the Media array index. Top Shot typically exposes three IPFS entries: `VIDEO_SQUARE`, `VIDEO`, `HERO`. The adapter takes the lowest-ranked; a verifier MAY re-dispatch on `mediaType` |
| `metadata_cid` | (not on chain for Top Shot) | OPO v0.2 §4 "chain-as-manifest" case applies — all equivalent fields are chain-sourced, so step 4 reduces to internal consistency |

## Important — why `media_cid` is NOT in `MetadataViews.Display.thumbnail`

Top Shot's `Display.thumbnail` resolves to a `MetadataViews.HTTPFile` pointing
at `assets.nbatopshot.com`, not an `IPFSFile`. An adapter that reads only the
`Display` view will return an empty CID and fail step 1. The correct view
for OPO purposes is `MetadataViews.Medias`, which enumerates the IPFS-backed
HERO/VIDEO renditions. This adapter walks that array.

## Trust assumptions

- Flow mainnet consensus.
- `rest-mainnet.onflow.org` reachability (verifier MAY substitute any public
  Flow REST endpoint, including a self-hosted access node).
- IPFS gateway reachability for the configured `OPO_IPFS_GW` (default
  `dweb.link`, NOT operated by Dapper). The gateway MUST honor raw-block
  retrieval (`?format=raw`) so the returned bytes hash to the CID multihash.

## Out-of-scope (matches SPEC §6 + portal "honest limits")

- Floor price, last-sale, market depth.
- Top Shot Score, challenge progress, set-completion badges, full-team bonus.
- Showcase arrangement, custodial username↔address mapping.
- Pre-migration edition CID binding (waits on Layer-5 migration).

## Run

```bash
npm install
# Live
node verify.js --token-id 40105574 --holder 0x0bb3b2a249ca6822

# Conformance (offline, no network)
cd ../.. && node conformance/run.js adapters/flow-topshot/verify.js

# Conformance (live)
cd ../.. && OPO_LIVE=1 node conformance/run.js adapters/flow-topshot/verify.js
```
