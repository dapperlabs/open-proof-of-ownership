# Open Proof-of-Ownership (OPO) — Specification v0.5

**Status:** Draft
**License:** CC0 1.0 Universal (public domain)
**Editors:** Initial publication, 2026-04
**Repository:** github.com/dapperlabs/open-proof-of-ownership

## Changes from v0.4

- §7 adds a **conformance coverage requirement**: a conforming adapter
  claiming to be "generic" for a given chain's metadata pattern (e.g.
  `erc721-generic`) MUST ship conformance vectors covering at least two
  distinct contracts whose CID encodings differ along at least one of
  three axes: (a) baseURI CID version (v0 vs v1), (b) metadata leaf
  codec (dag-pb UnixFS vs raw), (c) image payload layout (UnixFS-inline
  vs chunked-file Merkle root). Adapters bound to a single contract are
  exempt from this requirement.
- §8 clarifies that the reference `erc721-generic` adapter has been
  exercised against two independent collections (Azuki 0xED5A…C544 and
  Pudgy Penguins 0xBd35…2cf8) whose encodings together cover all three
  axes above — this is the minimum "generic" coverage for this class of
  adapter in v0.5.
- §5 adds an observation that has been true since v0.1 but was not
  explicit: the sha2-256 hash check in step 3 is performed against the
  returned block under the returned CID. For a chunked-file root block,
  this binds the CID to the ROOT block's bytes; the Merkle links inside
  that root block cryptographically bind the (unfetched) child blocks.
  A verifier MAY, but need NOT, recursively fetch child blocks — the
  root-block hash is a sufficient commitment to the whole file under
  the dag-pb + UnixFS protocol.

## Changes from v0.3

- §4 step 3 admits an OPTIONAL **two-gateway cross-check** for path-resolved
  retrieval. A verifier MAY query a second independent non-issuer gateway
  for the same `<dirCID>/<path>` and require that both gateways advertise
  the same leaf CID (via `x-ipfs-roots` or ETag) before trusting the
  primary's bytes. Failure of agreement is a step-3 failure.
- §5 trust assumption v0.3 ("gateway UnixFS traversal correctness") is
  weakened when cross-check is active: a substitution attack now requires
  collusion between TWO independent gateways, not one.
- §8 adapters MAY expose a `crosscheck` option and/or honour a
  `OPO_IPFS_CROSSCHECK=1` environment signal. When active, adapters MUST
  use two gateways operated by independent organisations; they MUST NOT
  satisfy the cross-check by querying two endpoints of the same operator.

## Changes from v0.2

- §4 step 3 extended to admit **path-resolved retrieval** for chain-pinned
  manifests whose tokenURI is a directory reference (`ipfs://<dirCID>/<path>`).
  A verifier MAY accept a leaf CID returned by a non-issuer gateway so long
  as it cryptographically verifies the retrieved bytes against that CID;
  the dominant ERC-721 pattern (`baseURI + tokenId`) relies on this.
- §5 trust assumptions updated to name the path-resolution case: the
  verifier trusts the gateway's HAMT/directory traversal to the extent of
  "this leaf CID IS the file at <path>" and independently verifies its
  bytes.
- §8 clarifies that adapters implementing path resolution MUST report the
  resolved leaf CID as `metadata_cid` / `media_cid` (not the declared
  directory CID).

## Changes from v0.1

- §3: `metadata_cid` demoted from REQUIRED to OPTIONAL; a new "chain-as-manifest"
  clause in §4 permits its omission when chain-state exposes the equivalent
  fields directly.
- §3: `media_cid` accepts any CID (v0 or v1) whose multihash is sha2-256; v0.1
  required CIDv1 exclusively, which excluded a majority of issued Flow and
  Ethereum NFTs.
- §4: step 4 clarified for the two cases (pinned-manifest vs chain-as-manifest).
- §7: conformance harness MUST support an offline fixture mode; live mode is
  OPTIONAL.

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
- **Chain-pinned manifest**: a document whose CID — or a directory reference
  resolvable to a unique file CID — is stored on-chain under a known binding
  and whose JSON contains OPO-shaped fields.
- **Directory reference**: an `ipfs://<dirCID>/<path>` URI whose leaf
  resolution is deterministic given the directory's UnixFS structure.

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
| `metadata_cid` | OPTIONAL | string (CID, sha2-256 multihash) | chain or chain-pinned manifest |

A field is "from chain" if its value is derivable from a stateless read of a
public RPC endpoint or block explorer for the named contract.

A field is "from chain-pinned manifest" if it appears in a document whose CID
— or a directory reference resolvable to a unique file CID under that
directory — is itself stored on-chain under a binding the adapter declares.

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

   **Path-resolved retrieval.** When the chain-declared reference is a
   directory reference `ipfs://<dirCID>/<path>` rather than a direct CID,
   the verifier MAY request the raw block at `/<dirCID>/<path>` from a
   non-issuer trustless gateway. The gateway SHALL return the leaf CID
   (via `x-ipfs-roots` or an ETag of the form `"<cid>.raw"`) and the raw
   bytes of that leaf. The verifier MUST compute sha2-256 of the bytes and
   confirm equality with the multihash digest of the returned leaf CID
   before treating either as trusted. The adapter MUST report the leaf CID
   as `media_cid` (or `metadata_cid`) — never the declared directory CID.

   **Two-gateway cross-check (OPTIONAL strengthening).** A verifier MAY
   query a second independent non-issuer gateway for the same
   `<dirCID>/<path>` and require that both gateways advertise the same
   leaf CID in their response headers. The two gateways MUST be operated
   by independent organisations (e.g. `gateway.pinata.cloud` and
   `ipfs.io`); two endpoints of a single operator do NOT satisfy
   independence. The second gateway MAY be probed with `HEAD` rather than
   `GET` — only the header-advertised leaf CID is needed, not the raw
   bytes. (In practice, some public gateways answer `HEAD` for path-style
   raw requests where `GET` would be refused by a downstream trustless
   gateway; `HEAD` is the more portable probe.) If the two leaf CIDs
   disagree, the verifier MUST fail step 3 with a cross-check error.
   Agreement weakens the v0.3 "single-gateway directory traversal
   correctness" assumption to "collusion between two independent gateways
   would be required for substitution to go undetected." The second
   gateway's bytes need not be hashed; the hash check against the primary
   gateway's bytes already establishes byte-for-byte integrity against
   whichever leaf CID the primary advertised.
4. If `metadata_cid` is present ("pinned-manifest case"): resolve it (by
   direct CID or path resolution per step 3) and retrieve the JSON. If the
   manifest declares `edition_id` or `serial`, those MUST match the
   chain-sourced values. If the manifest declares an `image` (or
   `image_url`) reference, its resolved leaf CID MUST equal `media_cid`.
   Failure: report step 4.

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
- For path-resolved retrieval only, in the single-gateway case: that the
  gateway performs UnixFS directory traversal correctly (i.e. returns the
  actual file at `<path>` under `<dirCID>`). A compromised gateway could
  return a different file's bytes for the path — the verifier would still
  detect tampering of the returned bytes against the returned leaf CID,
  but not substitution of one leaf for another under the same path.
- For path-resolved retrieval with the two-gateway cross-check enabled
  (§4 step 3): that the two chosen gateways are operated by independent
  organisations AND are not colluding. Substitution under this mode
  requires both to advertise the same substituted leaf CID; a single
  compromised gateway can no longer silently substitute. The verifier
  is responsible for choosing gateways whose operators have no shared
  ownership, infrastructure, or anchoring; this repository's reference
  adapter defaults to `ipfs.io` (Interplanetary Shipyard) as primary
  and `gateway.pinata.cloud` (Pinata Cloud, Inc.) as secondary, which
  are operated by distinct entities as of 2026-04.

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

### 7.1 Generic-adapter coverage

An adapter that claims to be "generic" for a chain's dominant metadata
pattern (e.g. `erc721-generic` for the ERC-721 Metadata extension with
ipfs-hosted manifests) MUST ship conformance vectors drawn from AT LEAST
TWO distinct on-chain contracts whose CID encodings differ along at
least one of the following axes:

1. **baseURI CID version.** One contract MUST use CIDv0 (multibase-
   less, `Qm…`) and another MUST use CIDv1 (multibase-prefixed, e.g.
   `bafy…`).
2. **Metadata leaf codec.** One contract's metadata leaf MUST resolve
   to a `dag-pb` (UnixFS-inline) block and another MUST resolve to a
   `raw` (codec 0x55) block — the two common cases produced by `ipfs
   add` on a small JSON file depending on client flags.
3. **Image payload layout.** One contract's image CID SHOULD resolve
   to a UnixFS-inline block (small file, bytes live in the same block
   as the UnixFS header) and another SHOULD resolve to a chunked-file
   root (large file whose root block carries links to sub-block CIDs,
   no inline bytes).

An adapter bound to exactly one contract (e.g. the chain-specific
reference adapter for a single issuer's contract like Top Shot) is
exempt from §7.1 because "generic" is not claimed.

Rationale. The §4 verification procedure is defined in CID-agnostic
terms, but an adapter can silently depend on CID v0 byte layouts, on
UnixFS inlining, or on single-segment paths. The only way to catch
that dependency is to run the same adapter against contracts that
stress the other branches. The reference `erc721-generic` adapter in
this repository covers all three axes via Azuki (CIDv0 / dag-pb /
inline) and Pudgy Penguins (CIDv1 / raw / chunked-root).

## 8. Adapters

An adapter binds OPO field names to a specific chain's read methods. Adapters
MUST NOT introduce trust in non-chain sources for fields marked "from chain"
in Section 3. Adapters MUST accept an injectable transport for offline
conformance.

Adapters implementing path-resolved retrieval (§4 step 3) MUST:

- Use raw-block retrieval at a non-issuer gateway (`?format=raw` or
  `Accept: application/vnd.ipld.raw`).
- Parse the leaf CID from the gateway response (the final entry in
  `x-ipfs-roots`, or the ETag of the form `"<cid>.raw"`).
- Verify sha2-256 of the returned bytes against the leaf CID's multihash
  digest before using either.
- Report the leaf CID — not the declared directory CID — as the
  `metadata_cid` / `media_cid` field in the result envelope.

Adapters MAY expose a cross-check option (§4 step 3 OPTIONAL
strengthening) activated by a call-site flag or the environment variable
`OPO_IPFS_CROSSCHECK=1`. When active, the adapter MUST:

- Query a second gateway operated by an organisation independent of the
  primary.
- Fail with a step-3 cross-check error when the two gateways advertise
  different leaf CIDs for the same `<dirCID>/<path>`.
- Include both leaf CIDs and the agreement outcome in the step-3 record
  of the result envelope.

This repository provides reference adapters for:

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
- IPIP-402 — HTTP gateway trustless response headers (`x-ipfs-roots`).
- W3C Verifiable Credentials Data Model 2.0 — w3.org/TR/vc-data-model-2.0.
- ERC-721 — eips.ethereum.org/EIPS/eip-721.
- Flow NFT Metadata Standard (FLIP-0636) — github.com/onflow/flips.

---
This work is dedicated to the public domain under CC0 1.0 Universal.
