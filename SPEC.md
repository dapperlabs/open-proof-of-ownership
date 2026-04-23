# Open Proof-of-Ownership (OPO) — Specification v0.2

**Status:** Draft
**License:** CC0 1.0 Universal (public domain)
**Editors:** Initial publication, 2026-04
**Repository:** github.com/dapperlabs/open-proof-of-ownership

## Changes from v0.1

- §3: `metadata_cid` demoted from REQUIRED to OPTIONAL; a new "chain-as-manifest" clause in §4 permits its omission when chain-state exposes the equivalent fields directly.
- §3: `media_cid` accepts any CID (v0 or v1) whose multihash is sha2-256; v0.1 required CIDv1 exclusively, which excluded a majority of issued Flow and Ethereum NFTs.
- §4: step 4 clarified for the two cases (pinned-manifest vs chain-as-manifest).
- §7: conformance harness MUST support an offline fixture mode; live mode is OPTIONAL.

## 1. Scope

OPO specifies how a third party MAY independently verify, without trusting the
issuer, that a digital collectible identified by an on-chain token corresponds
to a specific media artifact and a specific holder account, using only public
chain-state and public content-addressed retrieval.

OPO does NOT specify rights, royalty, custody, transfer mechanics, or rendering.

## 2. Terminology

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY in this
document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174).

- **Token**: a non-fungible unit identified on a public ledger by a tuple
  (`chain`, `contract`, `token_id`).
- **Edition**: an issuer-defined grouping of tokens sharing media. An edition
  has a fixed maximum count once minted out.
- **Serial**: an integer in `[1, edition.size]` identifying a token within its
  edition.
- **CID**: a self-describing content address per multiformats, IPFS. Both CID
  v0 (base58btc, dag-pb, sha2-256 implicit) and CID v1 (multibase-prefixed,
  explicit codec and multihash) are in scope.
- **Holder**: the account currently controlling the token per chain consensus.
- **Verifier**: an independent process executing this specification.
- **Chain-pinned manifest**: a document whose CID is itself stored on-chain
  under a known binding and whose JSON contains OPO-shaped fields.

## 3. Required Fields

A conforming token record MUST expose the following fields, each obtainable
from public chain-state OR public content-addressed retrieval:

| Field | Required | Type | Source |
|---|---|---|---|
| `chain` | REQUIRED | string | configuration |
| `contract` | REQUIRED | string | configuration |
| `token_id` | REQUIRED | string | chain |
| `edition_id` | REQUIRED | string | chain |
| `serial` | REQUIRED | integer | chain |
| `edition_size` | REQUIRED | integer | chain |
| `holder` | REQUIRED | string | chain |
| `media_cid` | REQUIRED | string (CID, sha2-256 multihash) | chain or chain-pinned manifest |
| `metadata_cid` | OPTIONAL | string (CID, sha2-256 multihash) | chain |

A field is "from chain" if its value is derivable from a stateless read of a
public RPC endpoint or block explorer for the named contract.

A field is "from chain-pinned manifest" if it appears in a document whose CID
is itself stored on-chain under a binding the adapter declares.

If `metadata_cid` is absent, all chain-sourced fields MUST be internally
consistent (see §4, step 4).

## 4. Verification Procedure

A verifier MUST, for any token under test:

1. Read `holder`, `edition_id`, `serial`, `edition_size`, and `media_cid`
   from chain. The read MUST NOT traverse any issuer-operated API. If any
   REQUIRED field cannot be resolved, the token is NOT conforming and the
   verifier MUST report step 1 as the failed step.
2. Assert `1 <= serial <= edition_size`. Failure: report step 2.
3. Retrieve the encoded block identified by `media_cid` from at least one
   IPFS gateway NOT operated by the issuer. The sha2-256 of the retrieved
   bytes MUST equal the multihash digest decoded from `media_cid`. Failure:
   report step 3. Gateways MUST be invoked in raw-block mode (e.g. the
   `?format=raw` query or `Accept: application/vnd.ipld.raw` header); a
   UnixFS-decoded response will not hash to the CID of a wrapped file.
4. If `metadata_cid` is present ("pinned-manifest case"): resolve it and
   retrieve the JSON. The JSON MUST contain `edition_id`, `serial`, and a
   reference to `media_cid` consistent with step 3. Failure: report step 4.

   If `metadata_cid` is absent ("chain-as-manifest case"): step 4 is
   satisfied iff `edition_id`, `serial`, `edition_size`, and `media_cid`
   were all read from chain in step 1 AND steps 2–3 passed. The
   chain-state itself is the manifest; no off-chain JSON can disagree
   with it, so no additional check applies.
5. If any step fails, the token is NOT conforming under this
   specification. The verifier MUST report which step failed.

## 5. Trust Assumptions

A verifier under OPO trusts:

- The chain consensus of the named `chain`.
- The cryptographic soundness of the CID hash function (sha2-256 in this
  version).
- That at least one non-issuer IPFS gateway is reachable and honors raw-block
  retrieval.

A verifier under OPO does NOT trust:

- Any issuer-operated API.
- Any indexer not reproducible from chain-state.
- Any rendering, marketing, or display surface.

## 6. Out of Scope (Permanent Limits)

The following are NOT verifiable under OPO and MUST NOT be implied by a
conforming verifier:

- Floor price, last-sale price, market depth.
- Holder real-world identity.
- Application-layer constructs (badges, scores, set-completion, leaderboards)
  not bound to chain-state.
- Long-term media durability (OPO confirms retrievability at query time, not
  pinning policy).
- Pre-issuance provenance of the underlying creative work.
- Pre-migration editions whose CID bindings depend on issuer-operated
  metadata APIs (these fail step 1 until the binding is re-anchored on chain).

## 7. Conformance

An implementation is **conforming** if, for every token in the conformance
test vector set (`/conformance/vectors.json`), it produces output matching the
expected verification result and, for failing inputs, identifies the failed
step per Section 4.

The conformance harness (`/conformance/run.js`) MUST support an offline mode
in which every network call is satisfied from a recorded fixture under
`/conformance/fixtures/<vector-id>/`. This guarantees third-party
reproducibility without dependence on gateway or RPC availability. The same
harness MUST also support a live mode (`OPO_LIVE=1`) that replays each
vector against the live chain and at least one non-issuer IPFS gateway.

## 8. Adapters

An adapter binds OPO field names to a specific chain's read methods. Adapters
MUST NOT introduce trust in non-chain sources for fields marked "from chain"
in Section 3. Adapters MUST accept an injectable transport for offline
conformance. This repository provides reference adapters for:

- Flow + Cadence resource model (`/adapters/flow-topshot/`).
- EVM + ERC-721 with ERC-721 Metadata extension (`/adapters/erc721-generic/`).

## 9. Versioning

This document is versioned by SemVer. Breaking changes to required fields or
the verification procedure increment MAJOR. Additions to optional fields or
new adapters increment MINOR. Editorial changes increment PATCH.

## 10. Citations

- RFC 2119 — Key words for use in RFCs to Indicate Requirement Levels.
- RFC 8174 — Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- IPFS — multiformats CID, ipfs.tech/concepts/content-addressing.
- IPIP-412 — HTTP gateway raw-block responses (`?format=raw`).
- W3C Verifiable Credentials Data Model 2.0 — w3.org/TR/vc-data-model-2.0.
- ERC-721 — eips.ethereum.org/EIPS/eip-721.
- Flow NFT Metadata Standard (FLIP-0636) — github.com/onflow/flips.

---
This work is dedicated to the public domain under CC0 1.0 Universal.
