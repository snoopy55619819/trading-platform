// Vendors the files THIS service needs from Alpha Exchange's published spec.
//
//   node scripts/sync-spec.mjs           copy the current spec and stamp its version
//   node scripts/sync-spec.mjs --check   fail if our copy is stale
//
// We do not share files with the exchange - we implement against a published spec, the
// way a real firm builds to a venue's documentation. This service owns its own copy and
// its own sync, so rewriting it in another language means rewriting this one small file
// and nothing else.
//
// A stale copy is not a repo defect. It is integration work: read the diff, decide what
// changes, then re-sync.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// listings.json is the one file we need: which companies are listed, their tickers and
// names. The newswire writes about them; it never trades, so the FIX and feed specs are
// none of its business.
const FILES = ["listings.json"];

const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_SOURCE = join(SERVICE_ROOT, "..", "..", "exchange-alpha", "spec");
const VENDOR = join(SERVICE_ROOT, "vendor", "exchange-alpha");
const MANIFEST = join(VENDOR, "SPEC_VERSION.json");

/** @param {string} p */
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const published = JSON.parse(readFileSync(join(SPEC_SOURCE, "listings.json"), "utf8")).spec_version;

if (process.argv.includes("--check")) {
  if (!existsSync(MANIFEST)) {
    console.error("no vendored spec - run: pnpm spec:sync");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const changed = FILES.filter((f) => manifest.files[f] !== sha(join(SPEC_SOURCE, f)));
  if (changed.length || manifest.spec_version !== published) {
    console.error(`vendored spec is STALE (have ${manifest.spec_version}, published ${published})`);
    for (const f of changed) console.error(`  changed upstream: ${f}`);
    console.error("review the changes, then: pnpm spec:sync");
    process.exit(1);
  }
  console.log(`vendored spec up to date (${published})`);
} else {
  mkdirSync(VENDOR, { recursive: true });
  /** @type {Record<string, string>} */
  const files = {};
  for (const f of FILES) {
    copyFileSync(join(SPEC_SOURCE, f), join(VENDOR, f));
    files[f] = sha(join(VENDOR, f));
  }
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      { venue: "ALPHA", spec_version: published, synced_at: new Date().toISOString(), files },
      null, 2,
    ) + "\n",
  );
  console.log(`vendored Alpha Exchange spec ${published}: ${FILES.join(", ")}`);
}
