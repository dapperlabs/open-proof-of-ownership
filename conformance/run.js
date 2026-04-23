#!/usr/bin/env node
// OPO conformance harness.
//
// Usage:
//   node conformance/run.js <adapter/verify.js>             # offline (fixtures)
//   OPO_LIVE=1 node conformance/run.js <adapter/verify.js>  # hit mainnet
//
// The harness injects a fixture-backed transport in offline mode and the
// adapter's default (live) transport in live mode. A vector without a
// `fixture` field is skipped in offline mode; OPO_LIVE=1 is required.
//
// Fixture directory layout (union over current adapters):
//   flow-script-response.txt      -- base64-JSON-CDC envelope (flow-topshot)
//   rpc-<selector>.hex            -- eth_call result hex (erc721-generic)
//   path-map.json                 -- { "<cid>/<path>": "<leafCid>" } (primary gateway)
//   path-map-2.json               -- { "<cid>/<path>": "<leafCid>" } (second gateway, optional)
//   ipfs-<cid>.raw                -- raw IPLD block bytes
//   bigmap-<id>-<script_expr_hash>.json -- tezos big-map entry (tezos-fa2)

const fs = require("fs");
const path = require("path");

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function pass(msg) { console.log("PASS:", msg); }
function skip(msg) { console.log("SKIP:", msg); }

function fixtureTransport(fixtureDir) {
  return {
    // flow-topshot
    async postScript(_body) {
      const p = path.join(fixtureDir, "flow-script-response.txt");
      if (!fs.existsSync(p)) throw new Error(`flow fixture missing: ${p}`);
      return fs.readFileSync(p, "utf8").trim();
    },
    // erc721-generic
    async rpcCall(_to, data) {
      const selector = data.slice(0, 10); // "0x" + 4 bytes
      const p = path.join(fixtureDir, `rpc-${selector}.hex`);
      if (!fs.existsSync(p)) throw new Error(`rpc fixture missing: ${p}`);
      const txt = fs.readFileSync(p, "utf8").trim();
      if (txt.startsWith("ERROR:")) throw new Error(txt.slice(6).trim());
      return txt;
    },
    async resolveIpfsPath(dirCid, subpath) {
      const mapPath = path.join(fixtureDir, "path-map.json");
      if (!fs.existsSync(mapPath)) throw new Error(`path-map.json missing in ${fixtureDir}`);
      const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      const key = `${dirCid}/${subpath}`;
      const leafCid = map[key];
      if (!leafCid) throw new Error(`no fixture path mapping for ${key}`);
      const bytes = fs.readFileSync(path.join(fixtureDir, `ipfs-${leafCid}.raw`));
      return { leafCid, bytes };
    },
    async resolveIpfsPath2(dirCid, subpath) {
      const mapPath = path.join(fixtureDir, "path-map-2.json");
      if (!fs.existsSync(mapPath)) throw new Error(`path-map-2.json missing in ${fixtureDir}`);
      const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      const key = `${dirCid}/${subpath}`;
      const leafCid = map[key];
      if (!leafCid) throw new Error(`no fixture path-map-2 mapping for ${key}`);
      return { leafCid };
    },
    // tezos-fa2
    async getBigMapValue(bigMapId, scriptExprHash) {
      const p = path.join(fixtureDir, `bigmap-${bigMapId}-${scriptExprHash}.json`);
      if (!fs.existsSync(p)) {
        if (fs.existsSync(p + ".404")) return null;
        throw new Error(`tezos bigmap fixture missing: ${p}`);
      }
      return JSON.parse(fs.readFileSync(p, "utf8"));
    },
    // both
    async getIpfsRaw(cid) {
      const p = path.join(fixtureDir, `ipfs-${cid}.raw`);
      if (!fs.existsSync(p)) {
        const err = new Error(`ipfs fixture missing: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return fs.readFileSync(p);
    },
  };
}

async function main() {
  const adapterPath = process.argv[2];
  if (!adapterPath) {
    console.error("usage: node conformance/run.js <adapter/verify.js> [--vector <id>]");
    process.exit(2);
  }
  const wantVector = (() => {
    const i = process.argv.indexOf("--vector");
    return i > 0 ? process.argv[i + 1] : null;
  })();

  const adapter = require(path.resolve(adapterPath));
  if (typeof adapter.verify !== "function" || typeof adapter.id !== "string") {
    console.error("adapter must export { id: string, verify: async function }");
    process.exit(2);
  }

  const { vectors } = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));
  let subset = vectors.filter(v => v.adapter === adapter.id);
  if (wantVector) subset = subset.filter(v => v.id === wantVector);
  if (subset.length === 0) {
    console.error(`no vectors for adapter id "${adapter.id}"${wantVector ? ` and id "${wantVector}"` : ""}`);
    process.exit(2);
  }

  const live = process.env.OPO_LIVE === "1";
  const mode = live ? "LIVE" : "OFFLINE";
  console.log(`harness=${mode}  adapter=${adapter.id}  vectors=${subset.length}`);
  console.log("");

  for (const v of subset) {
    const hasFixture = !!v.fixture;
    if (!live && !hasFixture) { skip(`${v.id} (no fixture; OPO_LIVE=1 required)`); continue; }

    const opts = hasFixture && !live
      ? { transport: fixtureTransport(path.join(__dirname, v.fixture)) }
      : {};
    if (v.opts) Object.assign(opts, v.opts);

    let envelope;
    try {
      envelope = await adapter.verify(v.input, opts);
    } catch (e) {
      fail(`${v.id}: adapter threw: ${e.message}`);
      continue;
    }

    if (envelope.result !== v.expected.result) {
      fail(`${v.id}: result "${envelope.result}" != "${v.expected.result}"  failed_step=${envelope.failed_step}`);
      continue;
    }
    if ((envelope.failed_step ?? null) !== (v.expected.failed_step ?? null)) {
      fail(`${v.id}: failed_step ${envelope.failed_step} != ${v.expected.failed_step}`);
      continue;
    }
    if (v.expected.fields_present) {
      const missing = v.expected.fields_present.filter(f => envelope.fields[f] == null);
      if (missing.length) { fail(`${v.id}: missing fields ${missing.join(",")}`); continue; }
    }
    if (v.expected.field_values) {
      let bad = null;
      for (const [k, want] of Object.entries(v.expected.field_values)) {
        const got = envelope.fields[k];
        if (typeof want === "number" ? Number(got) !== want : String(got) !== String(want)) {
          bad = `${k} = ${JSON.stringify(got)} != ${JSON.stringify(want)}`;
          break;
        }
      }
      if (bad) { fail(`${v.id}: ${bad}`); continue; }
    }
    pass(v.id);
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(2); });
