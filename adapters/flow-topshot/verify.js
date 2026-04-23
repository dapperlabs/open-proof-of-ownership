#!/usr/bin/env node
// OPO adapter — Flow + Cadence reference implementation for the
// A.0b2a3299cc857e29.TopShot contract.
//
// Bindings (SPEC §3 + §8):
//   chain         := configuration ("flow-mainnet")
//   contract      := "A.0b2a3299cc857e29.TopShot" (Cadence canonical form)
//   token_id      := UInt64 Moment ID
//   edition_id    := TopShot.NFT.data.setID
//   serial        := TopShot.NFT.data.serialNumber
//   edition_size  := TopShot.getNumMomentsInEdition(setID, playID)
//   holder        := caller-supplied Address; the Cadence borrow verifies
//                    the Moment is held at that Address
//   media_cid     := first IPFSFile entry in MetadataViews.Medias, ordered
//                    by the Media array index
//   metadata_cid  := NOT on-chain for current Top Shot; handled per SPEC
//                    v0.2 §4 "chain-as-manifest" allowance.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FLOW_REST = process.env.OPO_FLOW_REST || "https://rest-mainnet.onflow.org";
const IPFS_GW   = process.env.OPO_IPFS_GW   || "https://dweb.link/ipfs/";
const CONTRACT_ADDR = "0x0b2a3299cc857e29";
const CADENCE_PATH = path.join(__dirname, "cadence", "getMomentMetadata.cdc");

// Injectable transport so the conformance harness can run offline against
// recorded fixtures. A live adapter wires globalThis.fetch; a fixture
// harness wires a function with the same contract.
function makeTransport({ fetchImpl = fetch } = {}) {
  return {
    async postScript(body) {
      const res = await fetchImpl(`${FLOW_REST}/v1/scripts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`flow rest ${res.status}`);
      return (await res.text()).trim();
    },
    async getIpfsRaw(cid) {
      // ?format=raw returns the encoded block whose sha256 matches the
      // multihash digest. Gateways that do not support this header fall
      // back to UnixFS-decoded bytes, which will NOT hash to the CID.
      const res = await fetchImpl(`${IPFS_GW}${cid}?format=raw`, {
        headers: { "accept": "application/vnd.ipld.raw" },
      });
      if (!res.ok) throw new Error(`ipfs ${res.status} for ${cid}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    },
  };
}

// --- JSON-CDC envelope decode ----------------------------------------------
// Flow REST returns script output as a JSON-encoded string whose body is
// base64(JSON-CDC). JSON-CDC is the tagged { type, value } envelope documented
// at https://cadence-lang.org/docs/json-cadence-spec .
function decodeFlowReturn(raw) {
  if (typeof raw === "string") {
    // Strip the surrounding JSON quotes if this came from `await res.text()`.
    let s = raw.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = JSON.parse(s);
    const decoded = Buffer.from(s, "base64").toString("utf8");
    return unwrapJsonCdc(JSON.parse(decoded));
  }
  return unwrapJsonCdc(raw);
}

function unwrapJsonCdc(node) {
  if (node == null) return node;
  if (Array.isArray(node)) return node.map(unwrapJsonCdc);
  if (typeof node !== "object") return node;

  // Struct: { type: "Struct", value: { id, fields: [{name, value}, ...] } }
  if (node.type === "Struct" && node.value && Array.isArray(node.value.fields)) {
    const out = {};
    for (const f of node.value.fields) out[f.name] = unwrapJsonCdc(f.value);
    return out;
  }
  // Dictionary: { type: "Dictionary", value: [{ key, value }, ...] }
  if (node.type === "Dictionary" && Array.isArray(node.value)) {
    const out = {};
    for (const kv of node.value) out[unwrapJsonCdc(kv.key)] = unwrapJsonCdc(kv.value);
    return out;
  }
  // Array: { type: "Array", value: [...] }
  if (node.type === "Array" && Array.isArray(node.value)) {
    return node.value.map(unwrapJsonCdc);
  }
  // Optional: { type: "Optional", value: inner | null }
  if (node.type === "Optional") {
    return node.value == null ? null : unwrapJsonCdc(node.value);
  }
  // Scalars: { type: "UInt64"|"Address"|"String"|..., value: "..." }
  if ("type" in node && "value" in node) {
    return node.value;
  }
  // Plain object: recurse
  const out = {};
  for (const k of Object.keys(node)) out[k] = unwrapJsonCdc(node[k]);
  return out;
}

// --- CID → multihash decode (CIDv0 base58btc + CIDv1 base32) ----------------
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
const B32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";
function b32decode(s) {
  const lower = s.toLowerCase();
  let bits = 0, val = 0;
  const out = [];
  for (const ch of lower) {
    const i = B32_ALPHA.indexOf(ch);
    if (i < 0) throw new Error(`b32: invalid char ${ch}`);
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}
function readVarint(buf, offset) {
  let n = 0, shift = 0, i = offset;
  while (true) {
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: n, next: i };
}
// Returns { hashCode, digest } for a CID's multihash, or throws.
function cidToMultihash(cid) {
  if (typeof cid !== "string" || !cid.length) throw new Error("cid: empty");
  if (cid.startsWith("Qm")) {
    // CIDv0: base58btc of raw multihash (dag-pb + sha2-256 implicit)
    const raw = b58decode(cid);
    if (raw.length < 2 || raw[0] !== 0x12 || raw[1] !== 0x20) {
      throw new Error("cidv0: not sha2-256/32");
    }
    return { version: 0, codec: 0x70, hashCode: 0x12, digest: raw.slice(2) };
  }
  if (cid.startsWith("b")) {
    // CIDv1 base32 lowercase: prefix 'b' then base32(<version><codec><multihash>)
    const bytes = b32decode(cid.slice(1));
    let o = 0;
    const v = readVarint(bytes, o); o = v.next;
    if (v.value !== 1) throw new Error(`cidv1: unexpected version ${v.value}`);
    const c = readVarint(bytes, o); o = c.next;
    const h = readVarint(bytes, o); o = h.next;
    const len = readVarint(bytes, o); o = len.next;
    const digest = bytes.slice(o, o + len.value);
    if (digest.length !== len.value) throw new Error("cidv1: short digest");
    return { version: 1, codec: c.value, hashCode: h.value, digest };
  }
  throw new Error(`cid: unsupported multibase prefix "${cid[0]}"`);
}

function verifyCidSha256(cid, bytes) {
  const mh = cidToMultihash(cid);
  if (mh.hashCode !== 0x12) {
    throw new Error(`cid: multihash ${mh.hashCode.toString(16)} not sha2-256`);
  }
  const actual = crypto.createHash("sha256").update(bytes).digest();
  return actual.equals(mh.digest);
}

// --- adapter pipeline -------------------------------------------------------
function pickPrimaryMediaCid(mediaCIDs) {
  // Prefer the lowest-ranked IPFS entry (as returned by the script).
  if (!Array.isArray(mediaCIDs) || mediaCIDs.length === 0) return null;
  const ranked = mediaCIDs
    .map(m => ({ cid: m.cid, mediaType: m.mediaType, rank: Number(m.rank) }))
    .filter(m => m.cid)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0] || null;
}

async function readChainFields(input, transport) {
  const cadence = fs.readFileSync(CADENCE_PATH, "utf8");
  const body = {
    script: Buffer.from(cadence).toString("base64"),
    arguments: [
      Buffer.from(JSON.stringify({ type: "UInt64", value: String(input.token_id) })).toString("base64"),
      Buffer.from(JSON.stringify({ type: "Address", value: input.holder || CONTRACT_ADDR })).toString("base64"),
    ],
  };
  const raw = await transport.postScript(body);
  const decoded = decodeFlowReturn(raw);
  const primary = pickPrimaryMediaCid(decoded.mediaCIDs);
  return {
    chain: input.chain || "flow-mainnet",
    contract: input.contract || "A.0b2a3299cc857e29.TopShot",
    token_id: String(input.token_id),
    edition_id: String(decoded.editionID),
    serial: Number(decoded.serial),
    edition_size: Number(decoded.editionSize),
    holder: String(decoded.holder),
    media_cid: primary ? primary.cid : null,
    media_type: primary ? primary.mediaType : null,
    metadata_cid: null, // see SPEC v0.2 §4 chain-as-manifest allowance
    _media_cids_all: decoded.mediaCIDs,
  };
}

function serialInRange(f) {
  return Number.isInteger(f.serial)
      && Number.isInteger(f.edition_size)
      && f.serial >= 1
      && f.edition_size >= 1
      && f.serial <= f.edition_size;
}

async function mediaHashMatches(f, transport) {
  if (!f.media_cid) return false;
  const bytes = await transport.getIpfsRaw(f.media_cid);
  return verifyCidSha256(f.media_cid, bytes);
}

// SPEC v0.2 §4 step 4 (chain-as-manifest case): if metadata_cid is null,
// step 4 is satisfied iff every equivalent field (edition_id, serial,
// edition_size, media_cid) is chain-sourced AND internally consistent.
// For TopShot this means: serial was just checked in step 2; media_cid
// was just checked in step 3; edition_id derives from the same resource
// read; there is no off-chain JSON to disagree with chain-state.
function metadataConsistent(f) {
  if (f.metadata_cid) {
    // Reserved for adapters that have an off-chain chain-pinned manifest.
    return false;
  }
  return typeof f.edition_id === "string" && f.edition_id.length > 0
      && Number.isInteger(f.serial)
      && Number.isInteger(f.edition_size)
      && typeof f.media_cid === "string" && f.media_cid.length > 0;
}

async function verify(input, opts = {}) {
  const transport = opts.transport || makeTransport();
  const steps = [];
  let fields = {};

  try {
    fields = await readChainFields(input, transport);
    steps.push({ step: 1, name: "read_chain_fields", ok: true });
  } catch (e) {
    return envelope({}, [{ step: 1, name: "read_chain_fields", ok: false, error: e.message }], 1);
  }
  if (!fields.media_cid) {
    return envelope(fields, [...steps, { step: 1, name: "read_chain_fields", ok: false, error: "no ipfs media_cid in MetadataViews.Medias" }], 1);
  }

  if (!serialInRange(fields)) {
    return envelope(fields, [...steps, { step: 2, name: "serial_in_range", ok: false }], 2);
  }
  steps.push({ step: 2, name: "serial_in_range", ok: true });

  let hashOk = false;
  try { hashOk = await mediaHashMatches(fields, transport); }
  catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: e.message }], 3);
  }
  if (!hashOk) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false }], 3);
  }
  steps.push({ step: 3, name: "media_cid_hash", ok: true });

  if (!metadataConsistent(fields)) {
    return envelope(fields, [...steps, { step: 4, name: "metadata_consistent", ok: false }], 4);
  }
  steps.push({ step: 4, name: "metadata_consistent", ok: true });

  // Scrub internal fields that don't belong in the conformance envelope.
  const publicFields = { ...fields };
  delete publicFields._media_cids_all;
  return envelope(publicFields, steps, null);
}

function envelope(fields, steps, failed_step) {
  return {
    spec_version: "0.6",
    result: failed_step === null ? "conforming" : "not_conforming",
    fields,
    steps,
    failed_step,
  };
}

module.exports = {
  id: "flow-topshot",
  verify,
  // internals exposed for conformance harness + unit testing
  _internals: { decodeFlowReturn, cidToMultihash, verifyCidSha256, makeTransport },
};

if (require.main === module) {
  const args = require("minimist")(process.argv.slice(2));
  verify({
    chain: "flow-mainnet",
    contract: args.contract || "A.0b2a3299cc857e29.TopShot",
    token_id: args["token-id"],
    holder: args.holder,
  }).then(e => console.log(JSON.stringify(e, null, 2)))
    .catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
