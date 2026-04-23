# Open Proof-of-Ownership (OPO) — Specification v0.1

**Status:** Draft
**License:** CC0 1.0 Universal (public domain)
**Editors:** Initial publication, 2026-04
**Repository:** github.com/dapperlabs/open-proof-of-ownership

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
- **CID**: a self-describing content address per multiformats/CID v1, IPFS.
- **Holder**: the account currently controlling the token per chain consensus.
- **Verifier**: an independent process executing this specification.

## 3. Required Fields

A conforming token record MUST expose the following fields, each obtainable
from public chain-state OR public content-addressed retrieval:

| Field | Type | Source |
|---|---|---|
| `chain` | string | configuration |
| `contract` | string | configuration |
| `token_id` | string | chain |
| `edition_id` | string | chain |
| `serial` | integer | chain |
| `edition_size` | integer | chain |
| `holder` | string | chain |
| `media_cid` | string (CIDv1) | chain or chain-pinned manifest |
| `metadata_cid` | string (CIDv1) | chain or chain-pinned manifest |

A field is "from chain" if its value is derivable from a stateless read of a
public RPC endpoint or block explorer for the named contract.

A field is "from chain-pinned manifest" if it appears in a document whose CID
is itself stored on-chain.

## 4. Verification Procedure

A verifier MUST, for any token under test:

1. Read `holder`, `edition_id`, `serial`, `edition_size` from chain.
2. Assert `1 <= serial <= edition_size`.
3. Resolve `media_cid` and retrieve the bytes from at least one IPFS gateway
   not operated by the issuer. The retrieved bytes MUST hash to `media_cid`.
4. Resolve `metadata_cid` and retrieve the JSON. The JSON MUST contain
   `edition_id`, `serial`, and a reference to `media_cid` consistent with
   step 3.
5. If any step fails, the token is NOT conforming under this specification.
   The verifier MUST report which step failed.

## 5. Trust Assumptions

A verifier under OPO trusts:

- The chain consensus of the named `chain`.
- The cryptographic soundness of the CID hash function.
- That at least one non-issuer IPFS gateway is reachable.

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

## 7. Conformance

An implementation is **conforming** if, for every token in the conformance
test vector set (`/conformance/vectors.json`), it produces output matching the
expected verification result and, for failing inputs, identifies the failed
step per Section 4.

## 8. Adapters

An adapter binds OPO field names to a specific chain's read methods. Adapters
MUST NOT introduce trust in non-chain sources for fields marked "from chain"
in Section 3. This repository provides reference adapters for:

- Flow + Cadence resource model (`/adapters/flow-topshot/`).
- EVM + ERC-721 with ERC-721 Metadata extension (`/adapters/erc721-generic/`).

## 9. Versioning

This document is versioned by SemVer. Breaking changes to required fields or
the verification procedure increment MAJOR. Additions to optional fields or
new adapters increment MINOR. Editorial changes increment PATCH.

## 10. Citations

- RFC 2119 — Key words for use in RFCs to Indicate Requirement Levels.
- RFC 8174 — Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- IPFS — multiformats CID v1, ipfs.tech/concepts/content-addressing.
- W3C Verifiable Credentials Data Model 2.0 — w3.org/TR/vc-data-model-2.0.
- ERC-721 — eips.ethereum.org/EIPS/eip-721.
- Flow NFT Metadata Standard (FLIP-0636) — github.com/onflow/flips.

---
This work is dedicated to the public domain under CC0 1.0 Universal.
