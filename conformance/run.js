#!/usr/bin/env node
// OPO conformance harness.
// Usage: node conformance/run.js <path-to-adapter-verify.js>
// The harness loads /conformance/vectors.json, filters to vectors whose
// adapter matches the loaded adapter, invokes adapter.verify(input) for each,
// and asserts result + failed_step against expected.

const fs = require("fs");
const path = require("path");

function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }
function pass(msg) { console.log("PASS:", msg); }

async function main() {
  const adapterPath = process.argv[2];
  if (!adapterPath) {
    console.error("usage: node conformance/run.js <adapter/verify.js>");
    process.exit(2);
  }
  const adapter = require(path.resolve(adapterPath));
  if (typeof adapter.verify !== "function" || typeof adapter.id !== "string") {
    console.error("adapter must export { id: string, verify: async function }");
    process.exit(2);
  }

  const vectorsPath = path.join(__dirname, "vectors.json");
  const { vectors } = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
  const subset = vectors.filter(v => v.adapter === adapter.id);

  if (subset.length === 0) {
    console.error(`no vectors for adapter id "${adapter.id}"`);
    process.exit(2);
  }

  for (const v of subset) {
    let envelope;
    try {
      envelope = await adapter.verify(v.input);
    } catch (e) {
      fail(`${v.id}: adapter threw: ${e.message}`);
      continue;
    }
    if (envelope.result !== v.expected.result) {
      fail(`${v.id}: result ${envelope.result} != ${v.expected.result}`);
      continue;
    }
    if ((envelope.failed_step ?? null) !== (v.expected.failed_step ?? null)) {
      fail(`${v.id}: failed_step ${envelope.failed_step} != ${v.expected.failed_step}`);
      continue;
    }
    if (v.expected.fields_present) {
      const missing = v.expected.fields_present.filter(f => !(f in envelope.fields));
      if (missing.length) {
        fail(`${v.id}: missing fields ${missing.join(",")}`);
        continue;
      }
    }
    pass(v.id);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
