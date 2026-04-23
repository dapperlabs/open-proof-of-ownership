#!/usr/bin/env node
// OPO conformance harness.
//
// Usage:
//   node conformance/run.js <adapter/verify.js>        # offline (fixtures)
//   OPO_LIVE=1 node conformance/run.js <adapter/verify.js>   # hit mainnet
//
// Contract with adapters:
//   adapter.id       : string adapter identifier (e.g. "flow-topshot")
//   adapter.verify(input, opts) : Promise<envelope>
//   opts.transport   : { postScript(body), getIpfsRaw(cid) }
//                      Offline mode injects a fixture-backed transport.
//                      Live mode lets the adapter use its default.
//
// A vector without a `fixture` field is skipped in offline mode with a
// SKIP marker — OPO_LIVE=1 is required to run it.

const fs = require("fs");
const path = require("path");

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function pass(msg) { console.log("PASS:", msg); }
function skip(msg) { console.log("SKIP:", msg); }

function fixtureTransport(fixtureDir) {
  const responsePath = path.join(fixtureDir, "flow-script-response.txt");
  return {
    async postScript(_body) {
      // Return the recorded response verbatim; adapter decodes as if from
      // the live Flow REST endpoint.
      return fs.readFileSync(responsePath, "utf8").trim();
    },
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
