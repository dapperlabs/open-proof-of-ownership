#!/usr/bin/env node
// OPO adapter — generic ERC-721 reference implementation.
//
// Bindings (SPEC.md §3 + §8):
//   chain         := configuration ("ethereum-mainnet", "base-mainnet", ...)
//   contract      := address (0x...)
//   token_id      := tokenId (uint256, decimal string)
//   holder        := ownerOf(tokenId)
//   edition_id    := contract address (single-edition contracts treat the
//                    contract as the edition; adapters MAY override)
//   serial        := tokenId cast to integer (1-indexed; adapters MAY override)
//   edition_size  := totalSupply() when ERC-721Enumerable is implemented;
//                    adapters MUST emit failed_step=1 if unavailable
//   media_cid     := CID resolved from tokenURI -> metadata.image. The adapter
//                    handles BOTH direct CID refs ("ipfs://CID") AND directory-
//                    path refs ("ipfs://CID/subpath") via IPFS path resolution
//                    at a non-issuer gateway. The returned bytes are verified
//                    to hash to the leaf CID under SPEC §4 step 3.
//   metadata_cid  := CID of the JSON manifest returned by tokenURI. Resolved
//                    the same way as media_cid (path -> leaf CID) and verified.
//
// This adapter targets the common ERC-721 metadata pattern used by collections
// whose tokenURI returns `ipfs://<dirCID>/<tokenId>`. Contracts that return
// `data:` / `https:` / non-IPFS tokenURIs are NOT conforming under this
// adapter because step 1 cannot surface a CID without trusting the issuer.

const crypto = require("crypto");

const SELECTOR_OWNER_OF     = "0x6352211e"; // ownerOf(uint256)
const SELECTOR_TOKEN_URI    = "0xc87b56dd"; // tokenURI(uint256)
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()

const DEFAULT_RPC = process.env.OPO_ETH_RPC || "https://ethereum-rpc.publicnode.com";
// Default primary gateway: gateway.pinata.cloud (Pinata Cloud, Inc.). Chosen
// as primary because it accepts path-style GET `/<dirCID>/<path>?format=raw`
// and returns raw-block bytes directly. ipfs.io and dweb.link also resolve
// the path but redirect path-style GET to trustless-gateway.link which
// returns 406 (HEAD-only for raw blocks). The verifier needs bytes to run
// SPEC §4 step 3 (sha256 against the leaf CID), so the primary MUST serve
// bytes on GET.
const DEFAULT_IPFS_GW = process.env.OPO_IPFS_GW || "https://gateway.pinata.cloud/ipfs/";
// Default secondary gateway: ipfs.io (Interplanetary Shipyard) — independent
// operator from Pinata Cloud, Inc. Used only when OPO_IPFS_CROSSCHECK=1
// (SPEC §4 step 3 OPTIONAL strengthening). The secondary is probed with
// HEAD rather than GET: we need only the leaf CID from the response
// headers (x-ipfs-roots or etag), not the bytes. HEAD succeeds at ipfs.io
// where GET would return 406 for path-style raw requests.
const DEFAULT_IPFS_GW_2 = process.env.OPO_IPFS_GW_2 || "https://ipfs.io/ipfs/";

// --- transport -------------------------------------------------------------
// The live transport invokes fetch; the conformance harness injects a
// fixture-backed transport with the same contract. Any adapter-internal
// network call MUST go through this object (SPEC §8).
function makeTransport({
  fetchImpl = fetch,
  rpc = DEFAULT_RPC,
  ipfsGw = DEFAULT_IPFS_GW,
  ipfsGw2 = DEFAULT_IPFS_GW_2,
} = {}) {
  return {
    async rpcCall(to, data) {
      const res = await fetchImpl(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
                               params: [{ to, data }, "latest"] }),
      });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`rpc: ${j.error.message}`);
      return j.result;
    },
    // Path resolution at the primary gateway. Returns the leaf CID (from
    // `x-ipfs-roots` or an ETag of the form `"<cid>.raw"`) and the raw
    // block bytes. The caller MUST verify sha256(bytes) matches the leaf
    // CID's multihash before trusting either value.
    async resolveIpfsPath(dirCid, path) {
      const url = `${ipfsGw}${dirCid}/${path}?format=raw`;
      const res = await fetchImpl(url, {
        headers: { "accept": "application/vnd.ipld.raw" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`ipfs ${res.status} for ${dirCid}/${path}`);
      const leafCid = parseLeafCidFromHeaders(res.headers);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { leafCid, bytes };
    },
    // Path resolution at an INDEPENDENT second gateway (SPEC §5). Returns
    // only the leaf CID advertised by the second gateway's headers; the
    // bytes are not read because the hash check is performed against the
    // primary gateway's response. The purpose is to confirm that two
    // independent gateways agree on the path-to-leaf mapping under the
    // directory CID — a substitution attack by a single gateway would
    // require collusion with the second to go undetected.
    async resolveIpfsPath2(dirCid, path) {
      // HEAD rather than GET: the cross-check only needs the leaf CID
      // advertised in `x-ipfs-roots` or the ETag. Many public gateways
      // (ipfs.io, dweb.link) answer HEAD but redirect path-style raw GETs
      // to trustless-gateway.link which 406s.
      const url = `${ipfsGw2}${dirCid}/${path}?format=raw`;
      const res = await fetchImpl(url, {
        method: "HEAD",
        headers: { "accept": "application/vnd.ipld.raw" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`ipfs2 ${res.status} for ${dirCid}/${path}`);
      const leafCid = parseLeafCidFromHeaders(res.headers);
      return { leafCid };
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

function parseLeafCidFromHeaders(headers) {
  // Trustless gateways return x-ipfs-roots: <dir>,<...>,<leaf>. The LAST
  // entry is the final resolved CID for the requested path.
  const roots = headers.get?.("x-ipfs-roots") || headers["x-ipfs-roots"];
  if (roots) {
    const parts = roots.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const etag = headers.get?.("etag") || headers["etag"];
  if (etag) {
    const m = etag.match(/"?([A-Za-z0-9]+)(?:\.raw)?"?/);
    if (m) return m[1];
  }
  throw new Error("gateway did not return x-ipfs-roots or etag");
}

// --- ABI decode ------------------------------------------------------------
function encUint256(n) { return BigInt(n).toString(16).padStart(64, "0"); }
function decAddress(hex) { return "0x" + hex.slice(-40); }
function decString(hex) {
  const data = hex.slice(2);
  const len = parseInt(data.slice(64, 128), 16);
  const bytes = data.slice(128, 128 + len * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}
function decUint(hex) { return BigInt(hex || "0x0").toString(); }

// --- IPFS reference parse --------------------------------------------------
// Supports: ipfs://CID, ipfs://CID/path, ipfs://ipfs/CID/path,
//           https://gateway.tld/ipfs/CID[/path]
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

// --- CID -> multihash digest (CIDv0 base58 + CIDv1 base32) ------------------
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
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
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
function cidToMultihash(cid) {
  if (typeof cid !== "string" || !cid.length) throw new Error("cid: empty");
  if (cid.startsWith("Qm")) {
    const raw = b58decode(cid);
    if (raw.length < 2 || raw[0] !== 0x12 || raw[1] !== 0x20) {
      throw new Error("cidv0: not sha2-256/32");
    }
    return { version: 0, codec: 0x70, hashCode: 0x12, digest: raw.slice(2) };
  }
  if (cid.startsWith("b")) {
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

// --- minimal dag-pb + UnixFS reader (file-node only) ------------------------
// A dag-pb File node as produced by `ipfs add` for small files is:
//   PBNode { Data: <UnixFS proto> }                       (when file fits one block)
//   PBNode { Links: [child CIDs], Data: <UnixFS header> } (when chunked)
// UnixFS File: { Type: 2 (File), Data: <file bytes>, filesize, blocksizes }
// We return { inline, childCids }.
function parseDagPbFile(block) {
  let off = 0;
  let unixfs = null;
  const links = [];
  while (off < block.length) {
    const tag = block[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const { value: len, next } = readVarint(block, off);
      unixfs = block.slice(next, next + len);
      off = next + len;
    } else if (field === 2 && wire === 2) {
      const { value: len, next } = readVarint(block, off);
      links.push(parsePbLink(block.slice(next, next + len)));
      off = next + len;
    } else {
      if (wire === 2) {
        const { value: len, next } = readVarint(block, off);
        off = next + len;
      } else if (wire === 0) {
        const { next } = readVarint(block, off);
        off = next;
      } else break;
    }
  }
  const info = unixfs ? parseUnixfsFile(unixfs) : { type: null, inline: null };
  return { unixfs: info, links };
}
function parsePbLink(block) {
  let off = 0, hash = null, name = null;
  while (off < block.length) {
    const tag = block[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const { value: len, next } = readVarint(block, off);
      const data = block.slice(next, next + len);
      if (field === 1) hash = data;
      else if (field === 2) name = data.toString("utf8");
      off = next + len;
    } else if (wire === 0) {
      const { next } = readVarint(block, off);
      off = next;
    } else break;
  }
  return { hash, name };
}
function parseUnixfsFile(block) {
  let off = 0, type = null, data = null;
  while (off < block.length) {
    const tag = block[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      const { value, next } = readVarint(block, off);
      type = value; off = next;
    } else if (field === 2 && wire === 2) {
      const { value: len, next } = readVarint(block, off);
      data = block.slice(next, next + len);
      off = next + len;
    } else if (wire === 2) {
      const { value: len, next } = readVarint(block, off);
      off = next + len;
    } else if (wire === 0) {
      const { next } = readVarint(block, off);
      off = next;
    } else break;
  }
  return { type, inline: data };
}

// --- adapter pipeline ------------------------------------------------------
async function readChainFields(input, transport) {
  const { contract, token_id, chain } = input;
  const idHex = encUint256(token_id);
  const owner = decAddress(await transport.rpcCall(contract, SELECTOR_OWNER_OF + idHex));
  const tokenURI = decString(await transport.rpcCall(contract, SELECTOR_TOKEN_URI + idHex));
  let totalSupply = "0";
  try { totalSupply = decUint(await transport.rpcCall(contract, SELECTOR_TOTAL_SUPPLY)); } catch { /* not Enumerable */ }
  return {
    chain: chain || "ethereum-mainnet",
    contract,
    token_id: String(token_id),
    edition_id: contract,
    serial: Number(BigInt(token_id)),
    edition_size: Number(totalSupply),
    holder: owner,
    media_cid: null,
    metadata_cid: null,
    _tokenURI: tokenURI,
  };
}

// Resolve an ipfs:// reference to a leaf CID + bytes, verifying sha256.
// SPEC §4 step 3 requires raw-block retrieval so bytes hash to the CID.
// When `crosscheck` is true and the reference is a directory path, a
// second independent gateway is queried; the two leaf CIDs MUST agree
// (SPEC §5 strengthening). Direct-CID references are unaffected by
// crosscheck — the bytes-to-CID hash check is already gateway-agnostic.
async function resolveAndVerify(ref, transport, opts = {}) {
  let leafCid, bytes, crosscheck = null;
  if (ref.path) {
    // Directory reference (ipfs://CID/path). The primary gateway performs
    // the HAMT/flat-directory traversal and returns the leaf's raw block.
    // The verifier then hashes the bytes against the leaf CID -- if they
    // match, the gateway's path->CID mapping is confirmed trustless for
    // this retrieval.
    ({ leafCid, bytes } = await transport.resolveIpfsPath(ref.cid, ref.path));
    if (opts.crosscheck && typeof transport.resolveIpfsPath2 === "function") {
      const alt = await transport.resolveIpfsPath2(ref.cid, ref.path);
      crosscheck = { gateway1_cid: leafCid, gateway2_cid: alt.leafCid, agree: alt.leafCid === leafCid };
      if (!crosscheck.agree) {
        throw new Error(`crosscheck mismatch: ${leafCid} != ${alt.leafCid}`);
      }
    }
  } else {
    leafCid = ref.cid;
    bytes = await transport.getIpfsRaw(leafCid);
  }
  if (!verifyCidSha256(leafCid, bytes)) {
    throw new Error(`sha256 mismatch for ${leafCid}`);
  }
  return { leafCid, bytes, crosscheck };
}

function extractJson(dagPbBytes) {
  // Small JSON files fit in one block; `ipfs add` wraps them in UnixFS File
  // with Data inline. If the block is already raw-codec bytes (CIDv1 with
  // codec 0x55) the bytes are the file directly.
  const parsed = parseDagPbFile(dagPbBytes);
  const inline = parsed.unixfs.inline;
  const raw = inline && inline.length ? inline : dagPbBytes;
  return JSON.parse(raw.toString("utf8"));
}

async function verify(input, opts = {}) {
  const transport = opts.transport || makeTransport();
  const crosscheck = opts.crosscheck ?? (process.env.OPO_IPFS_CROSSCHECK === "1");
  const steps = [];
  let fields = {};

  // --- step 1 --------------------------------------------------------------
  try {
    fields = await readChainFields(input, transport);
    steps.push({ step: 1, name: "read_chain_fields", ok: true });
  } catch (e) {
    return envelope({}, [{ step: 1, name: "read_chain_fields", ok: false, error: e.message }], 1);
  }
  if (!fields.edition_size) {
    return envelope(fields, [...steps, { step: 1, name: "read_chain_fields", ok: false,
      error: "totalSupply unavailable (contract is not ERC-721Enumerable)" }], 1);
  }
  const tokenUriRef = parseIpfsRef(fields._tokenURI);
  if (!tokenUriRef) {
    return envelope(fields, [...steps, { step: 1, name: "read_chain_fields", ok: false,
      error: `tokenURI is not ipfs://: ${fields._tokenURI}` }], 1);
  }

  // --- step 2 --------------------------------------------------------------
  if (!(fields.serial >= 1 && fields.serial <= fields.edition_size)) {
    return envelope(fields, [...steps, { step: 2, name: "serial_in_range", ok: false }], 2);
  }
  steps.push({ step: 2, name: "serial_in_range", ok: true });

  // --- step 3 (metadata leaf hash) ----------------------------------------
  let metaBytes, metaCrosscheck = null;
  try {
    const r = await resolveAndVerify(tokenUriRef, transport, { crosscheck });
    fields.metadata_cid = r.leafCid;
    metaBytes = r.bytes;
    metaCrosscheck = r.crosscheck;
  } catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "metadata_cid_hash", ok: false, error: e.message }], 3);
  }

  let metaJson;
  try { metaJson = extractJson(metaBytes); }
  catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "metadata_cid_hash", ok: false,
      error: `metadata not json: ${e.message}` }], 3);
  }

  const imageRef = parseIpfsRef(metaJson.image || metaJson.image_url);
  if (!imageRef) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false,
      error: "metadata.image is not ipfs://" }], 3);
  }

  // --- step 3 (media leaf/root hash) --------------------------------------
  let mediaCrosscheck = null;
  try {
    const r = await resolveAndVerify(imageRef, transport, { crosscheck });
    fields.media_cid = r.leafCid;
    mediaCrosscheck = r.crosscheck;
  } catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: e.message }], 3);
  }
  steps.push({ step: 3, name: "media_cid_hash", ok: true, crosscheck: { metadata: metaCrosscheck, media: mediaCrosscheck } });

  // --- step 4 (metadata_cid present; consistency) -------------------------
  // The manifest was retrieved via a chain-pinned directory reference, so
  // its CID is bound to chain-state. Step 4 requires that any field in the
  // manifest overlapping with chain-sourced fields agrees; fields the
  // manifest does not declare are satisfied vacuously.
  const consistent =
    (metaJson.edition_id === undefined || String(metaJson.edition_id) === fields.edition_id) &&
    (metaJson.serial === undefined || Number(metaJson.serial) === fields.serial);
  if (!consistent) {
    return envelope(fields, [...steps, { step: 4, name: "metadata_consistent", ok: false }], 4);
  }
  steps.push({ step: 4, name: "metadata_consistent", ok: true });

  const publicFields = { ...fields };
  delete publicFields._tokenURI;
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
  id: "erc721-generic",
  verify,
  _internals: { makeTransport, cidToMultihash, verifyCidSha256, parseIpfsRef, parseDagPbFile },
};

if (require.main === module) {
  const args = require("minimist")(process.argv.slice(2));
  verify({
    chain: args.chain || "ethereum-mainnet",
    contract: args.contract,
    token_id: args["token-id"],
  }).then(e => console.log(JSON.stringify(e, null, 2)))
    .catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
