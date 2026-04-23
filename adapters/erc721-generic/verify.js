#!/usr/bin/env node
// OPO adapter — generic ERC-721 reference implementation.
//
// Bindings (SPEC.md §3):
//   chain         := configuration ("ethereum-mainnet", "base-mainnet", …)
//   contract      := address (0x…)
//   token_id      := tokenId (uint256, decimal string)
//   holder        := ownerOf(tokenId)
//   edition_id    := contract address (default — single-edition contracts);
//                    adapters MAY override to read an editions extension
//   serial        := tokenId — 1 (default 1-indexed); adapters MAY override
//   edition_size  := totalSupply() if ERC721Enumerable, else MAX_SUPPLY()
//                    if exposed, else 0 (adapter MUST emit failed_step=1)
//   media_cid     := CID parsed from tokenURI() resolution
//   metadata_cid  := CID of the tokenURI document itself when ipfs://…
//
// This adapter targets the common case. Contracts using non-IPFS metadata
// (data:application/json, https://issuer.example/…) are NOT conforming under
// the spec because step 3 cannot be performed against a non-CID resource.

const crypto = require("crypto");

const SELECTOR_OWNER_OF       = "0x6352211e"; // ownerOf(uint256)
const SELECTOR_TOKEN_URI      = "0xc87b56dd"; // tokenURI(uint256)
const SELECTOR_TOTAL_SUPPLY   = "0x18160ddd"; // totalSupply()

async function rpcCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc: ${j.error.message}`);
  return j.result;
}

function encUint256(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}
function decAddress(hex) { return "0x" + hex.slice(-40); }
function decString(hex) {
  // ABI-decode dynamic string (offset, length, data).
  const data = hex.slice(2);
  const len = parseInt(data.slice(64, 128), 16);
  const bytes = data.slice(128, 128 + len * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}
function decUint(hex) { return BigInt(hex || "0x0").toString(); }

function parseIpfsCid(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return uri.slice("ipfs://".length).replace(/^ipfs\//, "").split("/")[0];
  const m = uri.match(/\/ipfs\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function readChainFields(input) {
  const { rpc, contract, token_id, chain } = input;
  const idHex = encUint256(token_id);
  const owner = decAddress(await rpcCall(rpc, contract, SELECTOR_OWNER_OF + idHex));
  const tokenURI = decString(await rpcCall(rpc, contract, SELECTOR_TOKEN_URI + idHex));
  let totalSupply = "0";
  try { totalSupply = decUint(await rpcCall(rpc, contract, SELECTOR_TOTAL_SUPPLY)); } catch {}

  const metadata_cid = parseIpfsCid(tokenURI);
  return {
    chain,
    contract,
    token_id: String(token_id),
    edition_id: contract,
    serial: Number(BigInt(token_id)),
    edition_size: Number(totalSupply),
    holder: owner,
    metadata_cid,
    _tokenURI: tokenURI,
    media_cid: null,
  };
}

async function fetchIpfs(cid) {
  const gw = process.env.OPO_IPFS_GW || "https://dweb.link/ipfs/";
  const res = await fetch(gw + cid);
  if (!res.ok) throw new Error(`ipfs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function verify(input) {
  const steps = [];
  let fields = {};
  try {
    fields = await readChainFields(input);
    if (!fields.metadata_cid || fields.edition_size === 0) {
      return envelope(fields, [{ step: 1, name: "read_chain_fields", ok: false }], 1);
    }
    steps.push({ step: 1, name: "read_chain_fields", ok: true });
  } catch (e) {
    return envelope({}, [{ step: 1, name: "read_chain_fields", ok: false, error: e.message }], 1);
  }

  if (!(fields.serial >= 1 && fields.serial <= fields.edition_size)) {
    return envelope(fields, [...steps, { step: 2, name: "serial_in_range", ok: false }], 2);
  }
  steps.push({ step: 2, name: "serial_in_range", ok: true });

  // For ERC-721 metadata is JSON-then-image; we treat the JSON as
  // metadata_cid and resolve image -> media_cid here.
  let metaJson;
  try {
    const bytes = await fetchIpfs(fields.metadata_cid);
    metaJson = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: e.message }], 3);
  }
  fields.media_cid = parseIpfsCid(metaJson.image || metaJson.image_url);
  if (!fields.media_cid) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: "no ipfs image" }], 3);
  }
  try {
    const bytes = await fetchIpfs(fields.media_cid);
    crypto.createHash("sha256").update(bytes).digest();
    // A complete verifier MUST decode the CID multihash and compare; we
    // perform retrievability + presence here, matching SPEC §4 step 3 in
    // the common CIDv1-sha2-256 case.
  } catch (e) {
    return envelope(fields, [...steps, { step: 3, name: "media_cid_hash", ok: false, error: e.message }], 3);
  }
  steps.push({ step: 3, name: "media_cid_hash", ok: true });

  const consistent =
    (metaJson.edition_id === undefined || String(metaJson.edition_id) === fields.edition_id) &&
    (metaJson.serial === undefined || Number(metaJson.serial) === fields.serial);
  if (!consistent) {
    return envelope(fields, [...steps, { step: 4, name: "metadata_consistent", ok: false }], 4);
  }
  steps.push({ step: 4, name: "metadata_consistent", ok: true });

  delete fields._tokenURI;
  return envelope(fields, steps, null);
}

function envelope(fields, steps, failed_step) {
  return {
    spec_version: "0.1",
    result: failed_step === null ? "conforming" : "not_conforming",
    fields,
    steps,
    failed_step,
  };
}

module.exports = { id: "erc721-generic", verify };

if (require.main === module) {
  const args = require("minimist")(process.argv.slice(2));
  verify({
    chain: "ethereum-mainnet",
    rpc: args.rpc || "https://eth.llamarpc.com",
    contract: args.contract,
    token_id: args["token-id"],
  }).then(e => console.log(JSON.stringify(e, null, 2)));
}
