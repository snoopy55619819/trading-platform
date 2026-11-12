// Vendors the files THIS service needs from the specs other companies publish: Alpha
// Exchange's and the newswire's.
//
//   node scripts/sync-spec.mjs           copy the current specs and stamp their versions
//   node scripts/sync-spec.mjs --check   fail if any copy is stale
//
// We do not share files with them - we implement against a published spec, the way a real
// firm builds to a venue's or a news vendor's documentation. This service owns its own
// copies and its own sync, so rewriting it in another language means rewriting this one
// small file and nothing else.
//
// A stale copy is not a repo defect. It is integration work: read the diff, decide what
// changes, then re-sync.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SERVICE_ROOT, "..", "..");

const SOURCES = [
  {
    // fix44.xml is what our FIX initiator implements (a test checks every tag and message
    // type we use against it); marketdata.proto is the feed we decode; listings.json is
    // what trades, its tick sizes and price bands, and where to connect.
    name: "exchange-alpha",
    spec: join(REPO, "exchange-alpha", "spec"),
    files: ["fix44.xml", "marketdata.proto", "listings.json"],
    versionFile: "listings.json",
  },
  {
    // newswire.json is where to connect and every category's tone; the schema is a
    // headline's shape; README.md is the protocol we follow (catch-up, dropping repeats).
    name: "newswire",
    spec: join(REPO, "participants", "newswire", "spec"),
    files: ["newswire.json", "headline.schema.json", "README.md"],
    versionFile: "newswire.json",
  },
];

/** @param {string} p */
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const check = process.argv.includes("--check");
let stale = false;

for (const source of SOURCES) {
  const vendor = join(SERVICE_ROOT, "vendor", source.name);
  const manifestPath = join(vendor, "SPEC_VERSION.json");
  const published = JSON.parse(readFileSync(join(source.spec, source.versionFile), "utf8")).spec_version;

  if (check) {
    if (!existsSync(manifestPath)) {
      console.error(`${source.name}: no vendored spec - run: pnpm spec:sync`);
      stale = true;
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const changed = source.files.filter((f) => manifest.files[f] !== sha(join(source.spec, f)));
    if (changed.length || manifest.spec_version !== published) {
      console.error(`${source.name}: vendored spec is STALE (have ${manifest.spec_version}, published ${published})`);
      for (const f of changed) console.error(`  changed upstream: ${f}`);
      stale = true;
      continue;
    }
    console.log(`${source.name}: vendored spec up to date (${published})`);
  } else {
    mkdirSync(vendor, { recursive: true });
    /** @type {Record<string, string>} */
    const files = {};
    for (const f of source.files) {
      copyFileSync(join(source.spec, f), join(vendor, f));
      files[f] = sha(join(vendor, f));
    }
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { source: source.name, spec_version: published, synced_at: new Date().toISOString(), files },
        null, 2,
      ) + "\n",
    );
    console.log(`vendored ${source.name} spec ${published}: ${source.files.join(", ")}`);
  }
}

if (stale) {
  console.error("review the changes, then: pnpm spec:sync");
  process.exit(1);
}
