#!/usr/bin/env node
// OPO adapter — Tezos FA2 reference implementation for single-edition
// (NFT-profile) FA2 contracts whose `token_metadata` big-map value
// contains an `ipfs://` URI under the empty-string key.
//
// Bindings (SPEC §3 + §8):
//   chain         := configuration ("tezos-mainnet", ...)
//   contract      := KT1 address (originated)
//   token_id      := nat (decimal string)
//   holder        := caller-supplied tz1/tz2/tz3/KT1 address; the
//                    adapter verifies a non-zero ledger balance at
//                    key (holder, token_id). FA2 ledgers are indexed
//                    by (address, nat) with no "owner_of(token_id)"
//                    chain primitive — a claimed holder MUST be
//                    supplied as input. This is a genuine
//                    account-model difference from EVM/Flow; see
//                    SPEC §5.3.
//   edition_id    := `${contract}:${token_id}` (each FA2 NFT-profile
//                    token_id is its own 1/1 edition)
//   serial        := 1 (1/1 — FA2 NFT profile pins supply==1)
//   edition_size  := 1 (adapter pins; the NFT profile of FA2 restricts
//                    each token_id to supply 1. An adapter that
//                    accepts non-1/1 FA2 contracts MUST override.)
//   metadata_cid  := CID decoded from token_metadata["] bytes
//   media_cid     := CID resolved from metadata JSON .artifactUri
//                    (preferred) or .image / .displayUri
//
// Two big-map queries are issued against Tezos RPC:
//   1. token_metadata/<script_expr_hash(pack(nat token_id))>
//   2. ledger/<script_expr_hash(pack((address holder, nat token_id)))>
//
// The second confirms the claimed holder. A 404 from big_maps/{id}/{hash}
// in (2) is treated as balance=0 under Tezos RPC semantics (missing key
// ⇒ no balance) and fails step 1.
//
// Big-map pointer IDs are adapter-configuration: they MUST be declared
// per-contract and verified once against the contract's /script endpoint
// (this adapter ships pointers for the fxhash gentk v1 reference
// contract KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE).

const crypto = require("crypto");

const DEFAULT_RPC = process.env.OPO_TEZOS_RPC || "https://mainnet.api.tez.ie";
const DEFAULT_IPFS_GW = process.env.OPO_IPFS_GW || "https://gateway.pinata.cloud/ipfs/";

// Per-contract big-map ids, discovered via /contracts/{addr}/script and
// hard-coded here. A verifier MUST independently re-derive these from the
// contract script once; the adapter's trust in them is pinned to that
// one-time check (see README.md's "big-map ids" note).
const CONTRACT_BIGMAPS = {
  "KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE": {
    ledger: 22785,         // pair(address, nat) -> nat balance
    token_metadata: 22789, // nat -> pair(nat, map(string, bytes))
  },
};

// --- transport -------------------------------------------------------------
// Same injection pattern as the other adapters. Any network call goes
// through this object; conformance harness replaces it with a fixture-
// backed transport.
function makeTransport({
  fetchImpl = fetch,
  rpc = DEFAULT_RPC,
  ipfsGw = DEFAULT_IPFS_GW,
} = {}) {
  return {
    async getBigMapValue(bigMapId, scriptExprHash) {
      const url = `${rpc}/chains/main/blocks/head/context/big_maps/${bigMapId}/${scriptExprHash}`;
      const res = await fetchImpl(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`tezos ${res.status} for big_map ${bigMapId}/${scriptExprHash}`);
      return res.json();
    },
    async getIpfsRaw(cid) {
      const url = `${ipfsGw}${cid}?format=raw`;
      const res = await fetchImpl(url, {
        headers: { "accept": "application/vnd.ipld.raw" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`ipfs ${res.status} for ${cid}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// --- BLAKE2b (RFC 7693) variable-output-length pure-JS --------------------
// Node's crypto.createHash("blake2b512") is fixed-length 64 and can't be
// reconfigured via `outputLength`. Tezos script_expr_hash needs a 32-byte
// digest; the parameter block for outlen=32 alters the initial h[0] state
// so a simple truncation of blake2b-512 is NOT equivalent. This is a tiny
// faithful implementation against RFC 7693 §3.2.
const MASK64 = (1n << 64n) - 1n;
const B2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const B2B_SIGMA = [
  [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15],
  [14,10, 4, 8, 9,15,13, 6, 1,12, 0, 2,11, 7, 5, 3],
  [11, 8,12, 0, 5, 2,15,13,10,14, 3, 6, 7, 1, 9, 4],
  [ 7, 9, 3, 1,13,12,11,14, 2, 6, 5,10, 4, 0,15, 8],
  [ 9, 0, 5, 7, 2, 4,10,15,14, 1,11,12, 6, 8, 3,13],
  [ 2,12, 6,10, 0,11, 8, 3, 4,13, 7, 5,15,14, 1, 9],
  [12, 5, 1,15,14,13, 4,10, 0, 7, 6, 3, 9, 2, 8,11],
  [13,11, 7,14,12, 1, 3, 9, 5, 0,15, 4, 8, 6, 2,10],
  [ 6,15,14, 9,11, 3, 0, 8,12, 2,13, 7, 1, 4,10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5,15,11, 9,14, 3,12,13, 0],
];
function rotr64(x, n) {
  return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK64;
}
function g(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 63);
}
function blake2b(input, outlen) {
  if (outlen < 1 || outlen > 64) throw new Error(`blake2b: outlen ${outlen} out of [1,64]`);
  const msg = Buffer.from(input);
  const h = B2B_IV.slice();
  // Parameter block: first byte is outlen, second is keylen=0, third fanout=1, fourth depth=1.
  h[0] = h[0] ^ BigInt(0x01010000 | outlen);

  const BLOCK = 128;
  const nBlocks = msg.length === 0 ? 1 : Math.ceil(msg.length / BLOCK);
  for (let i = 0; i < nBlocks; i++) {
    const isLast = i === nBlocks - 1;
    const start = i * BLOCK;
    const end = Math.min(start + BLOCK, msg.length);
    const bytesThisBlock = end - start;
    const block = Buffer.alloc(BLOCK);
    msg.copy(block, 0, start, end);

    const bytesSoFar = BigInt(isLast ? msg.length : (i + 1) * BLOCK);
    const tLow = bytesSoFar & MASK64;
    const tHigh = (bytesSoFar >> 64n) & MASK64;

    const m = new Array(16);
    for (let k = 0; k < 16; k++) m[k] = block.readBigUInt64LE(k * 8);

    const v = new Array(16);
    for (let k = 0; k < 8; k++) v[k] = h[k];
    for (let k = 0; k < 8; k++) v[k + 8] = B2B_IV[k];
    v[12] ^= tLow;
    v[13] ^= tHigh;
    if (isLast) v[14] = v[14] ^ MASK64;

    for (let r = 0; r < 12; r++) {
      const s = B2B_SIGMA[r % 10];
      g(v, 0, 4,  8, 12, m[s[ 0]], m[s[ 1]]);
      g(v, 1, 5,  9, 13, m[s[ 2]], m[s[ 3]]);
      g(v, 2, 6, 10, 14, m[s[ 4]], m[s[ 5]]);
      g(v, 3, 7, 11, 15, m[s[ 6]], m[s[ 7]]);
      g(v, 0, 5, 10, 15, m[s[ 8]], m[s[ 9]]);
      g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(v, 2, 7,  8, 13, m[s[12]], m[s[13]]);
      g(v, 3, 4,  9, 14, m[s[14]], m[s[15]]);
    }
    for (let k = 0; k < 8; k++) h[k] = h[k] ^ v[k] ^ v[k + 8];
  }

  const out = Buffer.alloc(outlen);
  for (let i = 0; i < outlen; i++) {
    const word = Number((h[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
    out[i] = word;
  }
  return out;
}

// --- base58check (Tezos prefix-based) -------------------------------------
// Standard base58check: payload = prefix_bytes || body; checksum = first 4
// bytes of sha256(sha256(payload)); final = base58(payload || checksum).
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest(); }
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHA[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58_ALPHA.indexOf(ch);
    if (i < 0) throw new Error(`b58: invalid char ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function b58checkEncode(prefix, body) {
  const payload = Buffer.concat([Buffer.from(prefix), Buffer.from(body)]);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return b58encode(Buffer.concat([payload, checksum]));
}
function b58checkDecode(str, expectedPrefix) {
  const raw = b58decode(str);
  const body = raw.slice(0, raw.length - 4);
  const checksum = raw.slice(raw.length - 4);
  const ours = sha256(sha256(body)).slice(0, 4);
  if (!ours.equals(checksum)) throw new Error(`b58check: bad checksum on ${str}`);
  const prefix = Buffer.from(expectedPrefix);
  if (!body.slice(0, prefix.length).equals(prefix)) {
    throw new Error(`b58check: prefix mismatch for ${str}`);
  }
  return body.slice(prefix.length);
}

// Tezos base58 prefixes (multi-byte, as bytes):
const TEZOS_PREFIX = {
  tz1: [0x06, 0xa1, 0x9f], // ed25519_public_key_hash
  tz2: [0x06, 0xa1, 0xa1], // secp256k1_public_key_hash
  tz3: [0x06, 0xa1, 0xa4], // p256_public_key_hash
  KT1: [0x02, 0x5a, 0x79], // contract_hash
  expr: [0x0d, 0x2c, 0x40, 0x1b], // script_expr_hash
};

// Pack a Tezos address into its 22-byte wire form:
// implicit (tz1/tz2/tz3): [0x00, tag, 20-byte-hash]  (tag: 0x00=tz1, 0x01=tz2, 0x02=tz3)
// originated (KT1):       [0x01, 20-byte-hash, 0x00]
function packAddressBytes(addr) {
  if (addr.startsWith("tz1")) {
    const h = b58checkDecode(addr, TEZOS_PREFIX.tz1);
    if (h.length !== 20) throw new Error(`tz1 hash length ${h.length}`);
    return Buffer.concat([Buffer.from([0x00, 0x00]), h]);
  }
  if (addr.startsWith("tz2")) {
    const h = b58checkDecode(addr, TEZOS_PREFIX.tz2);
    return Buffer.concat([Buffer.from([0x00, 0x01]), h]);
  }
  if (addr.startsWith("tz3")) {
    const h = b58checkDecode(addr, TEZOS_PREFIX.tz3);
    return Buffer.concat([Buffer.from([0x00, 0x02]), h]);
  }
  if (addr.startsWith("KT1")) {
    const h = b58checkDecode(addr, TEZOS_PREFIX.KT1);
    return Buffer.concat([Buffer.from([0x01]), h, Buffer.from([0x00])]);
  }
  throw new Error(`unknown tezos address prefix: ${addr}`);
}

// Tezos zarith (signed variable-length int used by PACK for int/nat).
// First byte: bit7=continuation, bit6=sign(0=positive), bits5-0=value bits 5-0.
// Continuation bytes: bit7=continuation, bits6-0=value bits.
function zarithEncode(n) {
  const big = BigInt(n);
  if (big < 0n) throw new Error("zarithEncode: negative not used by FA2 nat");
  const out = [];
  // First byte: 6 value bits
  let v = big;
  let first = Number(v & 0x3fn);
  v >>= 6n;
  if (v > 0n) first |= 0x80;
  out.push(first);
  while (v > 0n) {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

// Tezos PACK binary encoding (Michelson wire + 0x05 magic prefix).
// Tag 0x00 = int (nats serialise as non-negative int), followed by zarith.
// Tag 0x07 = prim with 2 args no annot, followed by 1-byte prim_id.
//   Prim IDs: 0x07 = Pair, (others unused here).
// Tag 0x0a = bytes, followed by 4-byte big-endian length + raw bytes.
function packNat(n) {
  return Buffer.concat([Buffer.from([0x00]), zarithEncode(n)]);
}
function packAddressValue(addr) {
  const body = packAddressBytes(addr);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x0a]), len, body]);
}
function packPairAddrNat(addr, n) {
  return Buffer.concat([
    Buffer.from([0x07, 0x07]),
    packAddressValue(addr),
    packNat(n),
  ]);
}
function packWithMagic(body) {
  return Buffer.concat([Buffer.from([0x05]), body]);
}

function scriptExprHash(packedWithMagic) {
  const h = blake2b(packedWithMagic, 32);
  return b58checkEncode(TEZOS_PREFIX.expr, h);
}

// --- IPFS + CID primitives (reused shape from erc721-generic) -------------
function parseIpfsRef(uri) {
  if (!uri) return null;
  let rest = null;
  if (uri.startsWith("ipfs://")) rest = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  else {
    const m = uri.match(/\/ipfs\/(.+)$/);
    if (m) rest = m[1];
  }
  if (!rest) return null;
  const slash = rest.indexOf("/");
  if (slash === -1) return { cid: rest, path: null };
  return { cid: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

const CID_B58 = B58_ALPHA;
function cidV0ToDigest(cid) {
  // Qm... CIDv0 is base58-raw (no checksum) of multihash bytes:
  // [0x12 (sha2-256), 0x20 (len=32), 32 digest bytes]
  let n = 0n;
  for (const ch of cid) {
    const i = CID_B58.indexOf(ch);
    if (i < 0) throw new Error(`cidv0: invalid b58 char ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of cid) { if (ch === "1") bytes.unshift(0); else break; }
  const raw = Buffer.from(bytes);
  if (raw.length !== 34 || raw[0] !== 0x12 || raw[1] !== 0x20) {
    throw new Error(`cidv0: not sha2-256/32 (len=${raw.length})`);
  }
  return raw.slice(2);
}

function cidV1ToDigest(cid) {
  // b... CIDv1 base32-lowercase. Format after strip of 'b' multibase:
  // [varint(version), varint(codec), varint(hashCode), varint(len), digest]
  if (!cid.startsWith("b")) throw new Error(`cidv1: expected base32 'b' prefix, got ${cid[0]}`);
  const B32 = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, val = 0;
  const out = [];
  for (const ch of cid.slice(1).toLowerCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`cidv1: invalid b32 char ${ch}`);
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  const b = Buffer.from(out);
  let o = 0;
  function varint() {
    let n = 0, shift = 0;
    while (true) {
      const byte = b[o++];
      n |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return n;
  }
  const version = varint();
  if (version !== 1) throw new Error(`cidv1: version=${version}`);
  const codec = varint(); void codec;
  const hashCode = varint();
  if (hashCode !== 0x12) throw new Error(`cidv1: hashCode 0x${hashCode.toString(16)} not sha2-256`);
  const len = varint();
  if (len !== 32) throw new Error(`cidv1: digest len=${len}`);
  return b.slice(o, o + 32);
}

function cidToSha256Digest(cid) {
  if (cid.startsWith("Qm")) return cidV0ToDigest(cid);
  if (cid.startsWith("b"))  return cidV1ToDigest(cid);
  throw new Error(`cid: unknown prefix "${cid[0]}"`);
}
function verifyCidSha256(cid, bytes) {
  const expected = cidToSha256Digest(cid);
  const actual = crypto.createHash("sha256").update(bytes).digest();
  return actual.equals(expected);
}

// Minimal dag-pb + UnixFS reader (only what a File-root or chunked-root
// needs for extracting the inline JSON or acknowledging chunked-root).
function readVarintFromBuf(buf, offset) {
  let n = 0, shift = 0, i = offset;
  while (true) {
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: n, next: i };
}
function parseDagPbFile(block) {
  let off = 0;
  let unixfs = null;
  while (off < block.length) {
    const tag = block[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const { value: len, next } = readVarintFromBuf(block, off);
      unixfs = block.slice(next, next + len);
      off = next + len;
    } else if (wire === 2) {
      const { value: len, next } = readVarintFromBuf(block, off);
      off = next + len;
    } else if (wire === 0) {
      const { next } = readVarintFromBuf(block, off);
      off = next;
    } else break;
  }
  if (!unixfs) return { type: null, inline: null };
  let u = 0, type = null, data = null;
  while (u < unixfs.length) {
    const tag = unixfs[u++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      const { value, next } = readVarintFromBuf(unixfs, u);
      type = value; u = next;
    } else if (field === 2 && wire === 2) {
      const { value: len, next } = readVarintFromBuf(unixfs, u);
      data = unixfs.slice(next, next + len);
      u = next + len;
    } else if (wire === 2) {
      const { value: len, next } = readVarintFromBuf(unixfs, u);
      u = next + len;
    } else if (wire === 0) {
      const { next } = readVarintFromBuf(unixfs, u);
      u = next;
    } else break;
  }
  return { type, inline: data };
}
function extractJson(block) {
  const parsed = parseDagPbFile(block);
  const bytes = (parsed.inline && parsed.inline.length) ? parsed.inline : block;
  return JSON.parse(bytes.toString("utf8"));
}

// --- Tezos big-map value parsers ------------------------------------------
// token_metadata value: Pair nat (map string bytes).
// Returns the decoded URI string from the empty-key ("") entry, or null.
function extractTokenMetadataUri(mich) {
  if (!mich || mich.prim !== "Pair" || !Array.isArray(mich.args)) return null;
  const map = mich.args[1];
  if (!Array.isArray(map)) return null;
  for (const elt of map) {
    if (elt.prim === "Elt" && Array.isArray(elt.args) && elt.args.length === 2) {
      const [k, v] = elt.args;
      if (k && k.string === "" && v && typeof v.bytes === "string") {
        return Buffer.from(v.bytes, "hex").toString("utf8");
      }
    }
  }
  return null;
}
// ledger value: nat (balance).
function extractLedgerBalance(mich) {
  if (!mich || typeof mich.int !== "string") return null;
  return BigInt(mich.int);
}

// --- adapter pipeline -----------------------------------------------------
function envelope(fields, steps, failed_step) {
  return { spec_version: "0.6", result: failed_step === null ? "conforming" : "not_conforming",
           fields, steps, failed_step };
}

async function verify(input, opts = {}) {
  const transport = opts.transport || makeTransport();
  const steps = [];
  const { chain = "tezos-mainnet", contract, token_id, holder } = input;

  const publicFields = {
    chain, contract,
    token_id: String(token_id),
    edition_id: `${contract}:${token_id}`,
    serial: 1,
    edition_size: 1, // FA2 NFT-profile invariant; see bindings note.
    holder: holder || null,
    media_cid: null,
    metadata_cid: null,
  };

  const ptrs = CONTRACT_BIGMAPS[contract];
  if (!ptrs) {
    return envelope(publicFields, [{ step: 1, name: "bigmap_ptrs", ok: false,
      error: `no configured big-map pointers for contract ${contract}` }], 1);
  }
  if (!holder) {
    return envelope(publicFields, [{ step: 1, name: "holder_input", ok: false,
      error: "FA2 ledger is indexed by (address, token_id); holder MUST be supplied as input" }], 1);
  }

  // --- step 1: ledger lookup (holder confirmation) ------------------------
  let balance;
  try {
    const packedKey = packWithMagic(packPairAddrNat(holder, token_id));
    const hash = scriptExprHash(packedKey);
    const value = await transport.getBigMapValue(ptrs.ledger, hash);
    balance = value === null ? 0n : extractLedgerBalance(value);
    if (balance === null) throw new Error("ledger value not a nat");
  } catch (e) {
    return envelope(publicFields, [{ step: 1, name: "ledger_lookup", ok: false, error: e.message }], 1);
  }
  if (balance <= 0n) {
    return envelope(publicFields,
      [{ step: 1, name: "holder_has_balance", ok: false,
         error: `claimed holder ${holder} has balance ${balance} for token ${token_id}` }], 1);
  }
  steps.push({ step: 1, name: "ledger_holder_confirmed", ok: true });

  // --- step 1 (cont): token_metadata lookup for URI -----------------------
  let manifestUri;
  try {
    const packedKey = packWithMagic(packNat(token_id));
    const hash = scriptExprHash(packedKey);
    const value = await transport.getBigMapValue(ptrs.token_metadata, hash);
    if (value === null) throw new Error(`no token_metadata entry for token ${token_id}`);
    manifestUri = extractTokenMetadataUri(value);
    if (!manifestUri) throw new Error("token_metadata[\"\"] not present or not bytes");
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 1, name: "token_metadata_lookup", ok: false, error: e.message }], 1);
  }
  const metaRef = parseIpfsRef(manifestUri);
  if (!metaRef || metaRef.path) {
    return envelope(publicFields, [...steps, { step: 1, name: "token_metadata_uri", ok: false,
      error: `unsupported token_metadata uri: ${manifestUri}` }], 1);
  }
  steps.push({ step: 1, name: "token_metadata_uri_resolved", ok: true });

  // --- step 2: trivial (serial/edition_size both 1 by profile) ------------
  steps.push({ step: 2, name: "serial_in_range", ok: true });

  // --- step 3: fetch + sha256-verify the manifest block -------------------
  let manifestBytes;
  try {
    manifestBytes = await transport.getIpfsRaw(metaRef.cid);
    if (!verifyCidSha256(metaRef.cid, manifestBytes)) {
      throw new Error(`sha256 mismatch for ${metaRef.cid}`);
    }
    publicFields.metadata_cid = metaRef.cid;
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 3, name: "metadata_cid_hash", ok: false, error: e.message }], 3);
  }

  let metaJson;
  try { metaJson = extractJson(manifestBytes); }
  catch (e) {
    return envelope(publicFields, [...steps, { step: 3, name: "metadata_cid_hash", ok: false,
      error: `metadata not json: ${e.message}` }], 3);
  }

  // fxhash + HEN + OBJKT use artifactUri first; displayUri second; image as fallback.
  const mediaUri = metaJson.artifactUri || metaJson.displayUri || metaJson.image || metaJson.image_url;
  const mediaRef = parseIpfsRef(mediaUri);
  if (!mediaRef || mediaRef.path) {
    return envelope(publicFields, [...steps, { step: 3, name: "media_cid_hash", ok: false,
      error: `metadata.artifactUri/displayUri/image is not ipfs://<cid>: ${mediaUri}` }], 3);
  }

  try {
    const mediaBytes = await transport.getIpfsRaw(mediaRef.cid);
    if (!verifyCidSha256(mediaRef.cid, mediaBytes)) {
      throw new Error(`sha256 mismatch for ${mediaRef.cid}`);
    }
    publicFields.media_cid = mediaRef.cid;
  } catch (e) {
    return envelope(publicFields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: e.message }], 3);
  }
  steps.push({ step: 3, name: "media_cid_hash", ok: true });

  // --- step 4: pinned-manifest consistency --------------------------------
  // The manifest CID is chain-pinned (via token_metadata big-map). Any field
  // in the manifest that overlaps with a chain-sourced field MUST agree.
  // For FA2 NFT-profile, only token_id is overlapping — and fxhash-style
  // manifests don't redeclare it. No overlap ⇒ vacuously consistent.
  steps.push({ step: 4, name: "metadata_consistent", ok: true });

  return envelope(publicFields, steps, null);
}

module.exports = {
  id: "tezos-fa2",
  verify,
  _internals: { blake2b, scriptExprHash, packPairAddrNat, packNat, packWithMagic,
                b58checkEncode, b58checkDecode, extractTokenMetadataUri, cidToSha256Digest },
};

if (require.main === module) {
  const args = require("minimist")(process.argv.slice(2));
  verify({
    chain: args.chain || "tezos-mainnet",
    contract: args.contract,
    token_id: args["token-id"],
    holder: args.holder,
  }).then(e => console.log(JSON.stringify(e, null, 2)))
    .catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
