# Open Proof-of-Ownership (OPO) — Specification v0.7

**Status:** Draft
**License:** CC0 1.0 Universal (public domain)
**Editors:** Initial publication, 2026-04
**Repository:** github.com/dapperlabs/open-proof-of-ownership

## Changes from v0.6

- §3 introduces a `commitment_type` field on the result envelope and
  admits polymorphic media/metadata commitment identifiers. Two
  values are defined in v0.7: `ipfs-cid-sha256` (the v0.1–v0.6 case:
  identifier is an IPFS CID whose multihash is sha2-256) and
  `arweave-tx-id` (new in v0.7: identifier is an Arweave transaction
  id, 43-char base64url). New typed fields `media_commitment` and
  `metadata_commitment` are introduced on the result envelope. The
  existing field names `media_cid` / `metadata_cid` are retained as
  **backward-compatibility aliases** for the `ipfs-cid-sha256` case
  only, so existing adapters and conformance vectors continue to
  work unchanged. Adapters under non-IPFS commitment types MUST
  populate `media_commitment` / `metadata_commitment` (and MAY
  populate the `_cid` aliases only when the identifier also parses
  as a CID, which it generally will not).
- §4 step 3 splits along `commitment_type` into **content-addressed**
  retrieval (§4.3a — equivalent to v0.6 step 3, locally verifies
  sha2-256 of bytes against the CID multihash) and **transaction-
  committed** retrieval (§4.3b — fetches bytes from a gateway and
  cross-checks `data.size` and `tags[Content-Type]` against an
  independent envelope-indexing surface). The two branches provide
  measurably different integrity guarantees; see §5.4.
- §5.4 adds a new trust assumption applicable to transaction-committed
  storage: substitution detection requires **both** the raw-byte
  gateway AND the envelope-indexing surface (e.g. Arweave GraphQL)
  to agree on the substituted bytes. A single compromised surface
  cannot silently substitute — the size check alone catches
  append/truncate attacks — but the bytes are not themselves hashed
  into the on-chain commitment under this branch, so byte-identical
  substitutions that preserve size AND content-type evade detection.
  §5.4 is strictly weaker than §5.1 (content-addressed) and
  adapters operating under the §4.3b branch MUST document this in
  their README.
- §7.3 adds a **cross-chain media-layer coverage requirement**: the
  reference set MUST collectively exercise AT LEAST TWO
  media-integrity primitives, differentiated by the
  `commitment_type` axis. The v0.7 reference set (Flow/ERC-721/Tezos
  under `ipfs-cid-sha256`, plus Solana/Metaplex under
  `arweave-tx-id`) satisfies this.
- §8.3 documents the Solana/Metaplex/Arweave reference adapter: the
  Metaplex Token Metadata v1 PDA derivation, the SPL Token +
  token-account-owner holder-lookup (discovered-holder branch), and
  the Arweave size+Content-Type cross-check pattern.

## Changes from v0.5

- §4 step 1 distinguishes **discovered-holder** chains (the chain exposes
  a `f(token_id) -> holder` primitive such as ERC-721 `ownerOf`) from
  **confirmed-holder** chains (the chain's ledger is indexed by a
  composite key containing the holder address, so the verifier cannot
  learn the holder from chain-state alone and MUST accept `holder` as
  an input and confirm a non-zero balance at that key). Both branches
  satisfy §4 step 1. Adapters MUST declare which branch they
  implement.
- §5.3 adds a new trust assumption that applies only under the
  confirmed-holder branch: the verifier cannot derive uniqueness of
  holder from a single balance check; a chain-wide invariant (FA2 NFT
  profile's `supply=1`) OR a second read is required to claim
  "exclusive holder." Adapters bound to single-edition (1/1)
  profiles MAY pin `edition_size=1` as an adapter declaration, but
  MUST document this as a profile constraint in §8.
- §7.2 adds a **cross-chain coverage requirement**: the reference set
  of adapters in this repository MUST collectively exercise at least
  three chain families whose ownership/identity models differ along
  the axes listed in §7.2. The v0.6 reference set (Flow / Cadence
  resource-storage, EVM / ERC-721 `ownerOf`, Tezos / FA2 composite-
  key ledger) satisfies this. Adopters implementing OPO for a new
  chain family SHOULD contribute an adapter exercising an axis not
  covered by the reference set.
- §8 lists the new `tezos-fa2` reference adapter and documents the
  big-map-pointer resolution convention (per-contract, verified once
  against the contract's `/script` endpoint).

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
- **Chain-pinned manifest**: a document whose commitment identifier
  (CID for IPFS, transaction id for Arweave, or any future
  commitment type admitted under §3) — or a directory reference
  resolvable to a unique file-level identifier — is stored on-chain
  under a known binding and whose JSON contains OPO-shaped fields.
- **Commitment identifier**: an opaque string that binds a
  retrievable byte stream to an on-chain commitment, under the
  scheme named by `commitment_type`. For `ipfs-cid-sha256` it is a
  CID whose multihash is sha2-256; for `arweave-tx-id` it is a
  43-character base64url Arweave transaction id; extensions are
  permitted and MUST be listed in §8.
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
| `commitment_type` | REQUIRED | string (enum, see below) | adapter declaration |
| `media_commitment` | REQUIRED | string (commitment identifier per §2) | chain or chain-pinned manifest |
| `metadata_commitment` | OPTIONAL | string (commitment identifier per §2) | chain or chain-pinned manifest |
| `media_cid` | OPTIONAL (alias) | string (CID, sha2-256 multihash) | chain or chain-pinned manifest |
| `metadata_cid` | OPTIONAL (alias) | string (CID, sha2-256 multihash) | chain or chain-pinned manifest |

`commitment_type` is one of the enumerated values:

- `ipfs-cid-sha256` — the identifier is an IPFS CID (v0 or v1) whose
  multihash function is sha2-256. This is the v0.1–v0.6 default and
  applies to the reference Flow, ERC-721, and Tezos FA2 adapters.
- `arweave-tx-id` — the identifier is a 43-character base64url Arweave
  transaction id. Applies to the reference Solana/Metaplex adapter.
- Future values MUST be declared normatively in a new §8 adapter
  subsection and MUST define the step-3 retrieval-and-integrity
  procedure under §4.3.

**Backward-compatibility aliases.** The names `media_cid` and
`metadata_cid` are retained as aliases for `media_commitment` /
`metadata_commitment` **only** when `commitment_type ==
"ipfs-cid-sha256"`. Adapters under that type MUST populate both the
aliased and typed field names identically. Adapters under any other
`commitment_type` MUST populate only `media_commitment` /
`metadata_commitment` and MUST NOT populate `media_cid` /
`metadata_cid`. Consumers written against the v0.6 shape therefore
continue to work against IPFS-family adapters unchanged, and MUST
switch to the typed field names to consume any non-IPFS adapter.

A field is "from chain" if its value is derivable from a stateless read of a
public RPC endpoint or block explorer for the named contract.

A field is "from chain-pinned manifest" if it appears in a document whose
commitment identifier — or a directory reference resolvable to a unique
file-level identifier under that directory — is itself stored on-chain
under a binding the adapter declares.

If `metadata_commitment` (or its `metadata_cid` alias) is absent, all
chain-sourced fields MUST be internally consistent (see §4, step 4).

## 4. Verification Procedure

A verifier MUST, for any token under test:

1. Read `holder`, `edition_id`, `serial`, `edition_size`, and `media_cid`
   from chain. The read MUST NOT traverse any issuer-operated API. If any
   REQUIRED field cannot be resolved, the token is NOT conforming and the
   verifier MUST report step 1 as the failed step.

   **Discovered-holder branch.** When the chain exposes a
   `f(contract, token_id) -> holder` primitive (e.g. ERC-721
   `ownerOf(uint256)`), the verifier reads the holder directly from
   chain-state.

   **Confirmed-holder branch.** When the chain's ownership ledger is
   indexed by a composite key containing the holder address (e.g.
   Tezos FA2 `ledger : (address, nat) -> nat`), the chain does NOT
   expose a constant-time `ownerOf(token_id)` primitive, and
   scanning the entire ledger is infeasible without an indexer. In
   this case the verifier MUST accept `holder` as an input to the
   verification call AND read the ledger balance at
   `(holder, token_id)` from chain. Step 1 is satisfied iff the
   balance is non-zero; the verifier's claim is narrower than the
   discovered-holder branch ("the claimed holder holds a copy of
   this token") and does NOT establish exclusivity without the
   §5.3 assumption. Adapters using the confirmed-holder branch
   MUST declare this in their README so downstream consumers
   understand the narrower claim.
2. Assert `1 <= serial <= edition_size`. Failure: report step 2.
3. Retrieve the bytes committed to by `media_commitment` and confirm
   integrity against that commitment. The procedure branches on
   `commitment_type`:

   ### 4.3a Content-addressed retrieval (`commitment_type = "ipfs-cid-sha256"`)

   Retrieve the encoded block identified by `media_commitment` (i.e.
   `media_cid` under this commitment type) from at least one IPFS
   gateway NOT operated by the issuer. The sha2-256 of the retrieved
   bytes MUST equal the multihash digest decoded from the CID.
   Failure: report step 3. Gateways MUST be invoked in raw-block mode
   (e.g. the `?format=raw` query or `Accept: application/vnd.ipld.raw`
   header); a UnixFS-decoded response will not hash to the CID of a
   wrapped file.

   **Path-resolved retrieval.** When the chain-declared reference is a
   directory reference `ipfs://<dirCID>/<path>` rather than a direct CID,
   the verifier MAY request the raw block at `/<dirCID>/<path>` from a
   non-issuer trustless gateway. The gateway SHALL return the leaf CID
   (via `x-ipfs-roots` or an ETag of the form `"<cid>.raw"`) and the raw
   bytes of that leaf. The verifier MUST compute sha2-256 of the bytes and
   confirm equality with the multihash digest of the returned leaf CID
   before treating either as trusted. The adapter MUST report the leaf CID
   as `media_commitment` (`media_cid` under this commitment type) — never
   the declared directory CID.

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

   ### 4.3b Transaction-committed retrieval (`commitment_type = "arweave-tx-id"`)

   The commitment identifier is an Arweave transaction id. The integrity
   guarantee is fundamentally weaker than §4.3a because a tx-id is the
   hash of an RSA-PSS signature over a transaction envelope whose
   `data_root` is a merkle root over the data chunks — reconstructing
   the tx-id from bytes alone requires both `data_root` and the Arweave
   chunk-merkle tree, neither of which is uniformly exposed via public
   HTTP gateway CDNs as of 2026-04. See §5.4 for the associated trust
   assumption.

   The verifier MUST therefore perform a TWO-SURFACE CROSS-CHECK:

   (i) **Bytes surface.** Fetch the raw bytes from a non-issuer Arweave
   gateway at `/raw/<tx_id>` (or equivalent).

   (ii) **Envelope surface.** Query a structurally independent Arweave
   envelope index (e.g. the `/graphql` endpoint on the same or
   different gateway) for the same `tx_id`, retrieving at minimum the
   `data.size` and `tags[Content-Type]` fields.

   (iii) Assert `bytes.length === envelope.data.size` AND the envelope's
   `Content-Type` is appropriate for the role (`application/json` for a
   metadata manifest; `image/*` or another explicit media MIME for a
   media file). Any mismatch fails step 3.

   The adapter MUST report `media_commitment` as the tx-id used for the
   bytes fetch, and MUST surface the verified `data.size` and
   `Content-Type` in the step-3 record of the result envelope for
   auditability. The adapter MUST NOT populate `media_cid` under this
   commitment type.

   Adapters under §4.3b MAY upgrade to full `data_root` reconstruction
   (bringing the integrity guarantee to parity with §4.3a) without
   changing the external result envelope shape.
4. If `metadata_commitment` is present ("pinned-manifest case"):
   resolve it (per §4.3a if `commitment_type = "ipfs-cid-sha256"` or
   §4.3b if `commitment_type = "arweave-tx-id"`) and retrieve the JSON.
   If the manifest declares `edition_id` or `serial`, those MUST match
   the chain-sourced values. If the manifest declares an `image` (or
   `image_url` / `properties.files[].uri`) reference, the commitment
   identifier of that referenced asset (resolved leaf CID or Arweave
   tx-id) MUST equal `media_commitment`. Failure: report step 4.

   If `metadata_commitment` is absent ("chain-as-manifest case"): step 4
   is satisfied iff `edition_id`, `serial`, `edition_size`, and
   `media_commitment` were all read from chain in step 1 AND steps 2–3
   passed. The chain-state itself is the manifest; no off-chain JSON can
   disagree with it, so no additional check applies.
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

### 5.3 Confirmed-holder uniqueness (FA2 and similar composite-key ledgers)

Under the §4 step 1 confirmed-holder branch, a successful verification
establishes only that the claimed holder holds a non-zero balance of
`token_id` under `contract`. It does NOT, by itself, establish that the
claimed holder is the UNIQUE holder. Two cases are in scope:

- **Profile-constrained uniqueness.** When the contract commits to a
  profile that pins per-token_id total supply to 1 (e.g. the FA2 "NFT"
  profile under TZIP-12, or a `mint`-once-and-never-again contract
  invariant), the verifier MAY rely on that profile to claim
  exclusivity. The profile itself MUST be a chain-observable commitment
  (interface tag, entrypoint restriction, immutability marker) and not
  an off-chain declaration. An adapter that relies on a profile MUST
  name the profile in its README.
- **Unconstrained ledgers.** When no supply-1 profile is pinned,
  exclusivity requires at minimum a second read (e.g. a `total_supply`
  view, or a `balance_of` over the full holder set bounded by chain
  indexing). Adapters without access to such a read MUST report their
  output as "holder confirmed, uniqueness not claimed."

The reference `tezos-fa2` adapter in this repository relies on the
profile-constrained branch: fxhash gentk v1 mints each token_id as a
1/1 unique iteration, and the verifier pins `edition_size=1`. A
verifier re-using this adapter for non-1/1 FA2 contracts MUST override
both `edition_size` and the uniqueness claim.

### 5.4 Transaction-committed media integrity (Arweave and similar)

Under the §4.3b branch (`commitment_type = "arweave-tx-id"` or any
future commitment type that names an on-chain transaction
rather than a content hash), the verifier's step-3 guarantee is
strictly weaker than under §4.3a:

- **What IS detected under §4.3b.** Any substitution that changes
  `data.size` or that changes the envelope-advertised Content-Type is
  caught — this covers byte-level append/truncate, role-confusion
  (swapping a JSON manifest for an image payload or vice versa), and
  any attack that cannot simultaneously corrupt BOTH the raw-byte
  surface AND the envelope-index surface in a mutually-consistent way.
- **What is NOT detected under §4.3b.** A byte-identical-length
  substitution that preserves Content-Type — i.e. the attacker replaces
  the bytes at the commitment identifier with a different payload of
  identical length and compatible MIME — cannot be detected under this
  branch, because the on-chain commitment is not itself a hash of the
  served bytes. A full §5.1-equivalent guarantee requires the verifier
  to reconstruct `data_root` locally per the Arweave chunk-merkle spec,
  which is permitted by §4.3b but not required in v0.7.

Adapters operating under §4.3b MUST document this trust gap in their
README, name the two specific surfaces they cross-check (the byte
CDN URL template and the envelope-index URL / query shape), and name
the two organisations operating those surfaces. The reference
`solana-metaplex` adapter satisfies this by documenting its use of
`arweave.net/raw/<tx_id>` for bytes and `arweave.net/graphql` for the
envelope; a production deployment SHOULD configure the two surfaces
to resolve through independent operators (e.g. a second gateway's raw
route paired with a peer-node envelope query) rather than two
endpoints of the same CDN.

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

### 7.2 Cross-chain coverage

The reference set of adapters in this repository MUST collectively
exercise AT LEAST THREE chain families whose ownership/identity
models differ along the following axes:

1. **Ownership-lookup primitive.** One family MUST have a constant-
   time `ownerOf(token_id)` primitive (e.g. EVM / ERC-721). One
   family MUST require the holder as input and confirm it against a
   composite-key ledger (e.g. Tezos / FA2, `(address, token_id) ->
   balance`). One family MUST expose ownership through per-account
   resource storage rather than a global ownership map (e.g. Flow /
   Cadence resources scoped to account storage).
2. **Identity model.** One family MUST use content-addressed
   contract identity (e.g. Flow's `A.<addr>.<name>` canonical form).
   One family MUST use raw address hashes (e.g. EVM's
   `0x<hex40>`). One family MUST use base58check-prefixed addresses
   with embedded network/curve tags (e.g. Tezos's `tz1…` / `KT1…`).
3. **On-chain metadata surface.** At least one family MUST store
   the metadata manifest CID directly on-chain as a string
   (EVM `tokenURI` return, Tezos `token_metadata` big-map bytes).
   At least one family MUST reveal the manifest fields through a
   chain-as-manifest read rather than a pinned manifest (Flow
   Cadence `MetadataViews`).

These axes are chosen because each one is a place where an adapter
author could silently assume the wrong model and produce a verifier
that works for one chain's shape and not another's. A repository
claiming cross-chain applicability cannot rest on a single chain's
conventions; the spec is only as portable as its reference set.

Rationale. v0.5's §7.1 closed the "one-chain, two-contracts, all
hand-picked" critique within a chain family. §7.2 closes the
parallel "two-chains, both with ERC-721-shaped ownership lookup"
critique at the chain-family level. The v0.6 reference set (Flow
Top Shot, ERC-721 Azuki + Pudgy, Tezos FA2 fxhash gentk) covers all
three axes above.

The v0.6 reference set satisfies §7.2 as follows:

- Axis 1: EVM (Azuki / Pudgy) supplies constant-time `ownerOf`;
  Tezos (fxhash gentk v1) supplies composite-key ledger confirmation;
  Flow (Top Shot) supplies per-account resource storage.
- Axis 2: Flow supplies `A.0b2a3299cc857e29.TopShot` canonical
  identity; EVM supplies `0xED5AF388…`; Tezos supplies
  `KT1KEa8z…` and `tz1PoDdN…`.
- Axis 3: Tezos supplies on-chain CID storage via
  `token_metadata` big-map bytes; EVM supplies on-chain CID
  storage via `tokenURI` string; Flow supplies chain-as-manifest
  via `MetadataViews` resource field reads.

### 7.3 Cross-chain media-layer coverage

The reference set of adapters MUST collectively exercise AT LEAST
TWO distinct media-integrity primitives, differentiated by the
`commitment_type` axis introduced in §3. An adapter set covering
only `ipfs-cid-sha256` would encode, implicitly, that OPO's §4 step
3 is soundly defined only under a single content-hash primitive —
which §4.3b demonstrates it is not.

The v0.7 reference set satisfies §7.3 as follows:

- `ipfs-cid-sha256` — Flow Top Shot, ERC-721 (Azuki + Pudgy Penguins),
  Tezos FA2 fxhash gentk. Step 3 verifies sha2-256 of returned bytes
  against the multihash in the on-chain CID.
- `arweave-tx-id` — Solana Metaplex Token Metadata v1. Step 3 performs
  a two-surface cross-check per §4.3b.

Rationale. §7.2 established that a spec claiming cross-chain
applicability cannot rest on a single chain family's ownership model.
§7.3 is the parallel claim for the media layer: a spec whose only
integrity primitive is sha2-256-of-CID has a very different failure
surface than a spec forced to reason about transaction-committed
storage, and conflating them behind a single CID-typed field is a
silent-assumption bug the spec itself should surface. The v0.7
introduction of `commitment_type` + the Arweave-backed reference
adapter closes that gap.

An adopter implementing OPO for a chain family whose dominant media
layer is neither IPFS-with-sha256 nor Arweave (e.g. a chain where
media lives in calldata, on a purpose-built storage layer like
Shadow Drive, or under a post-quantum hash primitive) SHOULD
contribute a new `commitment_type` value under §8 and a §4.3c
retrieval-and-integrity procedure documenting its trust assumption.

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
- Tezos + FA2 single-edition profile (`/adapters/tezos-fa2/`).
- Solana + SPL Token + Metaplex Token Metadata v1 + Arweave
  (`/adapters/solana-metaplex/`).

### 8.1 Tezos FA2 adapter specifics

The `tezos-fa2` reference adapter uses the confirmed-holder branch
(§4 step 1) and is bound to FA2 contracts whose `token_metadata`
big-map value is of the canonical `pair nat (map string bytes)`
shape (TZIP-12 Section 3) with the manifest URI under the empty
string key. Each chain read is a native Tezos RPC call against
`/chains/main/blocks/head/context/big_maps/{ptr}/{script_expr_hash}`;
no indexer (tzkt / Blockwatch / dipdup) is consulted. The adapter
computes `script_expr_hash` locally (Michelson PACK →
blake2b-256 → base58check with the `expr` prefix `0d2c401b`) so
that the only trust placed in the RPC is for the VALUE at a given
(big-map-pointer, key-hash) tuple — the key-hash binding itself is
derived client-side.

Big-map pointer IDs (e.g. `ledger=22785`, `token_metadata=22789`
for KT1KEa8z…) are discovered by reading the contract's `/script`
endpoint once and matching them by path-annotation. The adapter
SHOULD ship a pointer table keyed by contract address rather than
re-reading the script on every verification; re-derivation is
needed only when the pointer table is updated.

### 8.3 Solana Metaplex adapter specifics

The `solana-metaplex` reference adapter is bound to the Metaplex
Token Metadata v1 single-edition (1/1) profile:

- SPL Token mint account with `decimals == 0` and `supply == 1`.
- Metaplex Token Metadata v1 PDA keyed by the mint, derived per the
  Metaplex program convention:

  ```
  PDA = findProgramAddress(
    [ "metadata",
      MetadataProgramId = metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s,
      mint ],
    MetadataProgramId)
  ```

- Manifest URI is parsed from the `uri` field of the Metaplex
  Metadata v1 Borsh layout and MUST resolve to Arweave
  (`https://arweave.net/<tx_id>` or `ar://<tx_id>`).
- Media URI is parsed from the manifest JSON's `image` (or
  `properties.files[0].uri` as fallback) and MUST also resolve to
  Arweave.

**Holder branch.** The adapter uses the §4 step 1 **discovered-holder**
branch: it queries `getTokenLargestAccounts(mint)` for the token
account holding supply 1, then reads that token account's owner
field (bytes 32..64 of the SPL Token Account layout) as `holder`.
No holder input is required from the caller.

**PDA pointer table.** Deriving a Metaplex PDA requires an ed25519
off-curve check (to find the highest bump whose candidate address is
NOT a valid curve point). Rather than ship a pure-JS ed25519
implementation for a constant that is computable once per mint, the
adapter maintains `MINT_METADATA_PDAS`, a table of pre-derived PDAs
keyed by mint address. A verifier MAY re-derive any entry
independently using any Solana SDK (`@solana/web3.js`'s
`PublicKey.findProgramAddressSync`) and compare. This parallels
§8.1's per-contract big-map pointer table.

**Commitment type.** `commitment_type = "arweave-tx-id"`. The step-3
integrity check follows §4.3b: the adapter fetches bytes from
`arweave.net/raw/<tx_id>` and cross-checks `data.size` and
`tags[Content-Type]` via a GraphQL query to
`arweave.net/graphql`. Section §5.4 applies: this is weaker than
§5.1 and the adapter's README documents the gap. A future version
reconstructing `data_root` locally per the Arweave chunk-merkle
spec would upgrade the guarantee without changing the result
envelope shape.

**RPC selection.** Public Solana RPC endpoints increasingly disable
`getProgramAccounts` and `getTokenLargestAccounts`; the adapter
defaults to an endpoint (`https://solana-rpc.publicnode.com`) that
permits both, and allows override via `OPO_SOLANA_RPC`.

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
