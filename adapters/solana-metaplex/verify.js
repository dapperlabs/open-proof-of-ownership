#!/usr/bin/env node
// OPO adapter — Solana (SPL Token + Metaplex Token Metadata v1) + Arweave-
// hosted media. Bound to the "single-edition" profile of Metaplex: SPL
// mint with decimals==0 and supply==1 (1/1 NFT).
//
// Bindings (SPEC §3 + §8):
//   chain                 := configuration ("solana-mainnet", ...)
//   contract              := SPL Token mint pubkey (base58, 32 bytes)
//   token_id              := same as contract; each mint IS its own token
//   holder                := OPTIONAL input; adapter reads the holder from
//                            chain. When holder is supplied, adapter
//                            additionally asserts chain-holder equals
//                            claimed holder. (Discovered-holder branch:
//                            Solana has a unique token-account-per-mint
//                            for supply-1 mints; holder := account.owner.)
//   edition_id            := the mint itself
//   serial                := 1
//   edition_size          := 1 (adapter-pinned via profile: SPL mint
//                               supply==1 under decimals==0).
//   metadata_commitment   := Arweave transaction id decoded from
//                            Metaplex metadata account `.uri` field
//   media_commitment      := Arweave transaction id for the image,
//                            resolved from the metadata JSON `.image`
//
// v0.7 commitment model (SPEC §5.4):
//   commitment_type = "arweave-tx-id". Unlike `ipfs-cid-sha256`, an
//   Arweave tx_id is NOT the content hash of the served bytes — it is
//   derived from an RSA-PSS signature over a merkle root of the
//   tx's data chunks, and reconstructing that binding client-side
//   requires access to the full tx envelope (including `data_root`).
//   Public Arweave gateway CDNs (as of 2026-04) do NOT universally
//   expose `/tx/<id>` for envelope access. This adapter therefore
//   performs a size+content-type cross-check via the Arweave GraphQL
//   surface instead of a local hash reconstruction. The spec §5.4
//   documents this as a strictly weaker integrity check than §5.1's
//   content-addressed hash verification. A future version that
//   reconstructs `data_root` locally (Arweave chunk-merkle per
//   spec) would upgrade this adapter to equivalent strength without
//   changing its external interface — the envelope is spec-
//   forwards-compatible.
//
// Metaplex metadata PDAs are deterministic from the mint:
//   PDA = findProgramAddressSync(
//     ["metadata", METADATA_PROGRAM_ID, mint],
//     METADATA_PROGRAM_ID
//   )
// which requires an ed25519 off-curve check. Rather than ship a
// pure-JS ed25519 curve implementation for a one-time-per-mint
// derivation, this adapter pins the PDA per mint in a table
// (MINT_METADATA_PDAS). A verifier MAY re-derive independently with
// any solana SDK and compare; this parallels the Tezos adapter's
// per-contract big-map pointer table.

const crypto = require("crypto");

const DEFAULT_RPC      = process.env.OPO_SOLANA_RPC || "https://solana-rpc.publicnode.com";
const DEFAULT_ARWEAVE  = process.env.OPO_ARWEAVE    || "https://arweave.net";
const DEFAULT_AR_GQL   = process.env.OPO_ARWEAVE_GQL|| "https://arweave.net/graphql";

const METADATA_PROGRAM_ID  = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Per-mint Metaplex metadata PDA table (pre-derived; re-derive with any
// solana SDK to verify).
const MINT_METADATA_PDAS = {
  "3saAedkM9o5g1u5DCqsuMZuC4GRqPB4TuMkvSsSVvGQ3": {
    metadata_pda: "9ap4ycBoX18mc7AZ54hfLghZmaADpbL94BvL6DTU6QqQ",
    bump: 255,
  },
};

// --- base58 (Bitcoin alphabet, used by Solana for pubkeys) ---------------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  if (typeof str !== "string") throw new Error("b58decode: not string");
  let n = 0n;
  for (const c of str) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`b58decode: invalid char ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 0xFFn)); n >>= 8n; }
  bytes.reverse();
  for (const c of str) { if (c !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

// --- SPL + Metaplex account decoders -------------------------------------
// SPL Mint layout (82 bytes):
//   mint_authority: Option<PublicKey>   (4 tag + 32)  offset 0..36
//   supply: u64_LE                      (8)           offset 36..44
//   decimals: u8                        (1)           offset 44
//   is_initialized: u8                  (1)           offset 45
//   freeze_authority: Option<PublicKey> (4 tag + 32)  offset 46..82
function decodeSplMint(b) {
  if (b.length < 82) throw new Error(`spl mint length ${b.length} < 82`);
  return {
    supply: b.readBigUInt64LE(36),
    decimals: b[44],
    is_initialized: !!b[45],
  };
}
// SPL Token Account layout (165 bytes):
//   mint[32]           offset 0..32
//   owner[32]          offset 32..64
//   amount: u64_LE     offset 64..72
//   ... (delegate, state, etc.)
function decodeSplTokenAccount(b) {
  if (b.length < 165) throw new Error(`spl token account length ${b.length} < 165`);
  return {
    mint:   b58encode(b.slice(0, 32)),
    owner:  b58encode(b.slice(32, 64)),
    amount: b.readBigUInt64LE(64),
  };
}
// Metaplex Token Metadata v1 layout (relevant prefix):
//   u8 key                                                 offset 0
//   update_authority[32]                                   offset 1..33
//   mint[32]                                               offset 33..65
//   u32 name_len + 32 bytes padded name                    offset 65..101
//   u32 symbol_len + 10 bytes padded symbol                offset 101..115
//   u32 uri_len + 200 bytes padded uri                     offset 115..319
//   u16 seller_fee_basis_points                            offset 319..321
//   Option<Vec<Creator>> ... (not decoded here)
function decodeMetaplexMetadataV1(b) {
  if (b.length < 319) throw new Error(`metaplex metadata length ${b.length} < 319`);
  if (b[0] !== 4) throw new Error(`metaplex metadata key=${b[0]} (expected 4 MetadataV1)`);
  const mint = b58encode(b.slice(33, 65));
  const name_len = b.readUInt32LE(65);
  if (name_len > 32) throw new Error(`metadata name_len=${name_len} > 32`);
  const name = b.slice(69, 69 + name_len).toString("utf8").replace(/\0+$/, "");
  const symbol_len = b.readUInt32LE(101);
  if (symbol_len > 10) throw new Error(`metadata symbol_len=${symbol_len} > 10`);
  const symbol = b.slice(105, 105 + symbol_len).toString("utf8").replace(/\0+$/, "");
  const uri_len = b.readUInt32LE(115);
  if (uri_len > 200) throw new Error(`metadata uri_len=${uri_len} > 200`);
  const uri = b.slice(119, 119 + uri_len).toString("utf8").replace(/\0+$/, "");
  return { mint, name, symbol, uri };
}

// --- Arweave URI parser --------------------------------------------------
// Accepts: https://arweave.net/<id>, https://arweave.net/<id>/<path>,
//          ar://<id>, ar://<id>/<path>. Returns null for non-Arweave URIs.
// Arweave tx ids are 43-char base64url ([A-Za-z0-9_-]{43}).
function parseArweaveUri(uri) {
  if (!uri || typeof uri !== "string") return null;
  const m = uri.match(/^(?:https?:\/\/(?:www\.)?arweave\.net\/|ar:\/\/)([A-Za-z0-9_-]{43})(?:\/([^?\s#]*))?(?:[?#].*)?$/);
  if (!m) return null;
  return { tx_id: m[1], path: m[2] || null };
}

// --- transport -----------------------------------------------------------
function makeTransport({
  fetchImpl = fetch,
  solanaRpc = DEFAULT_RPC,
  arweave   = DEFAULT_ARWEAVE,
  arweaveGql = DEFAULT_AR_GQL,
} = {}) {
  async function rpc(method, params) {
    const res = await fetchImpl(solanaRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`solana ${method} ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`solana ${method} rpc: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  return {
    async solGetAccountInfoBase64(pubkey) {
      const r = await rpc("getAccountInfo", [pubkey, { encoding: "base64" }]);
      return r && r.value; // { data: [b64, "base64"], owner, ... } | null
    },
    async solGetTokenLargestAccounts(mint) {
      const r = await rpc("getTokenLargestAccounts", [mint]);
      return r && r.value; // [ { address, amount, ... }, ... ]
    },
    async arweaveGetRaw(txId) {
      const url = `${arweave}/raw/${txId}`;
      const res = await fetchImpl(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`arweave raw ${res.status} for ${txId}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async arweaveGqlTx(txId) {
      const query = `{ transaction(id: "${txId}") { id owner { address } data { size } tags { name value } signature } }`;
      const res = await fetchImpl(arweaveGql, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`arweave graphql ${res.status}`);
      const j = await res.json();
      return j && j.data && j.data.transaction; // null if not found
    },
  };
}

// --- adapter pipeline ----------------------------------------------------
function envelope(fields, steps, failed_step) {
  return {
    spec_version: "0.7",
    commitment_type: "arweave-tx-id",
    result: failed_step === null ? "conforming" : "not_conforming",
    fields, steps, failed_step,
  };
}

async function verify(input, opts = {}) {
  const transport = opts.transport || makeTransport();
  const steps = [];
  const { chain = "solana-mainnet", contract /* mint */, holder: claimedHolder } = input;
  const token_id = input.token_id || contract;

  const publicFields = {
    chain, contract,
    token_id: String(token_id),
    edition_id: contract,
    serial: 1,
    edition_size: 1,
    holder: null,
    // v0.7 typed commitment fields:
    media_commitment: null,
    metadata_commitment: null,
    // v0.1-v0.6 backcompat aliases (adapters MAY populate):
    media_cid: null,
    metadata_cid: null,
  };

  const pdaEntry = MINT_METADATA_PDAS[contract];
  if (!pdaEntry) {
    return envelope(publicFields, [{
      step: 1, name: "metadata_pda_table", ok: false,
      error: `no pre-derived Metaplex metadata PDA configured for mint ${contract}. Derive with findProgramAddressSync(["metadata", ${METADATA_PROGRAM_ID}, mint], ${METADATA_PROGRAM_ID}) and add to MINT_METADATA_PDAS.`
    }], 1);
  }

  // --- step 1a: mint account (confirm SPL Token NFT with supply=1) ------
  let mintInfo;
  try {
    const acc = await transport.solGetAccountInfoBase64(contract);
    if (!acc) throw new Error(`mint account ${contract} not found`);
    if (acc.owner !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error(`mint owner ${acc.owner} is not SPL Token program`);
    }
    const raw = Buffer.from(acc.data[0], "base64");
    mintInfo = decodeSplMint(raw);
    if (!mintInfo.is_initialized) throw new Error("mint is not initialized");
    if (mintInfo.decimals !== 0) throw new Error(`mint decimals=${mintInfo.decimals}, not NFT (want 0)`);
    if (mintInfo.supply !== 1n) {
      throw new Error(`mint supply=${mintInfo.supply}, not 1/1 NFT (want 1)`);
    }
  } catch (e) {
    return envelope(publicFields, [{ step: 1, name: "mint_is_nft", ok: false, error: e.message }], 1);
  }
  steps.push({ step: 1, name: "mint_is_nft", ok: true });

  // --- step 1b: holder lookup (discovered-holder branch) ----------------
  try {
    const largest = await transport.solGetTokenLargestAccounts(contract);
    if (!Array.isArray(largest) || largest.length === 0) {
      throw new Error("no token accounts for mint");
    }
    const active = largest.find(a => String(a.amount) === "1");
    if (!active) {
      throw new Error(`no token account with amount=1 (largest: ${largest.map(a => a.amount).join(",")})`);
    }
    const tokAcc = await transport.solGetAccountInfoBase64(active.address);
    if (!tokAcc) throw new Error(`token account ${active.address} not found`);
    if (tokAcc.owner !== SPL_TOKEN_PROGRAM_ID) {
      throw new Error(`token account owner ${tokAcc.owner} is not SPL Token program`);
    }
    const decoded = decodeSplTokenAccount(Buffer.from(tokAcc.data[0], "base64"));
    if (decoded.mint !== contract) {
      throw new Error(`token account mint ${decoded.mint} != expected ${contract}`);
    }
    if (decoded.amount !== 1n) {
      throw new Error(`token account amount=${decoded.amount} != 1`);
    }
    publicFields.holder = decoded.owner;
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 1, name: "holder_from_chain", ok: false, error: e.message }], 1);
  }
  if (claimedHolder && claimedHolder !== publicFields.holder) {
    return envelope(publicFields, [...steps, {
      step: 1, name: "holder_claim_match", ok: false,
      error: `claimed holder ${claimedHolder} does not match on-chain holder ${publicFields.holder}`
    }], 1);
  }
  steps.push({ step: 1, name: "holder_from_chain", ok: true });

  // --- step 1c: metadata account -> URI ---------------------------------
  let meta;
  let metadataTxId;
  try {
    const acc = await transport.solGetAccountInfoBase64(pdaEntry.metadata_pda);
    if (!acc) throw new Error(`metadata account ${pdaEntry.metadata_pda} not found`);
    if (acc.owner !== METADATA_PROGRAM_ID) {
      throw new Error(`metadata owner ${acc.owner} is not Metaplex Token Metadata program`);
    }
    const raw = Buffer.from(acc.data[0], "base64");
    meta = decodeMetaplexMetadataV1(raw);
    if (meta.mint !== contract) {
      throw new Error(`Metaplex metadata.mint ${meta.mint} != requested mint ${contract}`);
    }
    const parsed = parseArweaveUri(meta.uri);
    if (!parsed) {
      throw new Error(`metadata uri ${JSON.stringify(meta.uri)} is not an Arweave transaction reference`);
    }
    if (parsed.path) {
      // For v0.7 we target the direct-tx-id form. Path-manifest Arweave
      // (data-root indexed sub-paths) is a separate feature to land later;
      // for now, fail step 1 with a clear error.
      throw new Error(`path-referenced Arweave uri not supported by this adapter: ${meta.uri}`);
    }
    metadataTxId = parsed.tx_id;
    publicFields.metadata_commitment = metadataTxId;
    publicFields.metadata_cid = metadataTxId;
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 1, name: "metadata_uri_from_chain", ok: false, error: e.message }], 1);
  }
  steps.push({ step: 1, name: "metadata_uri_from_chain", ok: true });

  // --- step 2: trivial for 1/1 ------------------------------------------
  steps.push({ step: 2, name: "serial_in_range", ok: true });

  // --- step 3: fetch + cross-check metadata tx, then image tx -----------
  let metaJson;
  try {
    const metaBytes = await transport.arweaveGetRaw(metadataTxId);
    const gql = await transport.arweaveGqlTx(metadataTxId);
    if (!gql) throw new Error(`arweave tx ${metadataTxId} not present in gateway's GraphQL index`);
    if (String(gql.data.size) !== String(metaBytes.length)) {
      throw new Error(`size mismatch for ${metadataTxId}: raw=${metaBytes.length} bytes, GraphQL data.size=${gql.data.size}`);
    }
    const ct = gql.tags.find(t => t.name.toLowerCase() === "content-type");
    if (!ct || !/json/i.test(ct.value)) {
      throw new Error(`metadata Content-Type=${ct ? ct.value : "<missing>"} not JSON`);
    }
    metaJson = JSON.parse(metaBytes.toString("utf8"));
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 3, name: "metadata_tx_crosscheck", ok: false, error: e.message }], 3);
  }

  const imageUri = metaJson.image
    || (metaJson.properties && metaJson.properties.files && metaJson.properties.files[0] && metaJson.properties.files[0].uri)
    || null;
  const imageRef = parseArweaveUri(imageUri);
  if (!imageRef) {
    return envelope(publicFields, [...steps, {
      step: 3, name: "image_uri_parse", ok: false,
      error: `metadata.image=${JSON.stringify(imageUri)} is not an Arweave transaction reference`
    }], 3);
  }
  if (imageRef.path) {
    return envelope(publicFields, [...steps, {
      step: 3, name: "image_uri_parse", ok: false,
      error: `path-referenced Arweave uri not supported by this adapter: ${imageUri}`
    }], 3);
  }
  const mediaTxId = imageRef.tx_id;
  try {
    const mediaBytes = await transport.arweaveGetRaw(mediaTxId);
    const gql = await transport.arweaveGqlTx(mediaTxId);
    if (!gql) throw new Error(`arweave tx ${mediaTxId} not present in gateway's GraphQL index`);
    if (String(gql.data.size) !== String(mediaBytes.length)) {
      throw new Error(`size mismatch for ${mediaTxId}: raw=${mediaBytes.length} bytes, GraphQL data.size=${gql.data.size}`);
    }
    const ct = gql.tags.find(t => t.name.toLowerCase() === "content-type");
    if (!ct || !/^image\//i.test(ct.value)) {
      throw new Error(`media Content-Type=${ct ? ct.value : "<missing>"} not image/*`);
    }
    // Record sha256 of the bytes for the step envelope (audit aid; not a
    // chain-bound hash under the arweave-tx-id commitment model).
    publicFields.media_commitment = mediaTxId;
    publicFields.media_cid = mediaTxId;
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 3, name: "media_tx_crosscheck", ok: false, error: e.message }], 3);
  }
  steps.push({ step: 3, name: "media_tx_crosscheck", ok: true });

  // --- step 4: pinned-manifest consistency ------------------------------
  // The on-chain Metaplex struct carries name + symbol. The off-chain
  // manifest carries name + symbol + image. Any overlap MUST match.
  if (metaJson.name && meta.name && metaJson.name !== meta.name) {
    return envelope(publicFields, [...steps, {
      step: 4, name: "metadata_consistent", ok: false,
      error: `manifest.name=${JSON.stringify(metaJson.name)} != on-chain name=${JSON.stringify(meta.name)}`
    }], 4);
  }
  if (metaJson.symbol && meta.symbol && metaJson.symbol !== meta.symbol) {
    return envelope(publicFields, [...steps, {
      step: 4, name: "metadata_consistent", ok: false,
      error: `manifest.symbol=${JSON.stringify(metaJson.symbol)} != on-chain symbol=${JSON.stringify(meta.symbol)}`
    }], 4);
  }
  steps.push({ step: 4, name: "metadata_consistent", ok: true });

  return envelope(publicFields, steps, null);
}

module.exports = {
  id: "solana-metaplex",
  verify,
  _internals: {
    b58encode, b58decode,
    decodeSplMint, decodeSplTokenAccount, decodeMetaplexMetadataV1,
    parseArweaveUri,
    MINT_METADATA_PDAS, METADATA_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID,
  },
};

if (require.main === module) {
  const args = require("minimist")(process.argv.slice(2));
  verify({
    chain: args.chain || "solana-mainnet",
    contract: args.contract,
    token_id: args["token-id"],
    holder: args.holder,
  }).then(e => console.log(JSON.stringify(e, null, 2)))
    .catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
