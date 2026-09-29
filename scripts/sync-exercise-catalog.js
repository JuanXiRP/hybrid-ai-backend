// Refresh the vendored free-exercise-db catalog (src/data/exercises.json).
//
// Plan generation is grounded in this catalog: the prompt lists it and the server resolves every
// strength exercise against it. See src/data/README.md for the source, licence and entry schema.
//
//   node scripts/sync-exercise-catalog.js            # latest commit on main
//   node scripts/sync-exercise-catalog.js <sha>      # a pinned commit
//
// Prints the ref that was fetched so it can be recorded in src/data/README.md.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "yuhonas/free-exercise-db";
const OUTPUT_PATH = fileURLToPath(
  new URL("../src/data/exercises.json", import.meta.url),
);

const ref = process.argv[2] ?? "main";
const url = `https://raw.githubusercontent.com/${REPO}/${ref}/dist/exercises.json`;

const run = async () => {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Fetching ${url} failed with HTTP ${response.status}.`);
    process.exit(1);
  }

  const catalog = await response.json();
  const isValid =
    Array.isArray(catalog) &&
    catalog.length > 0 &&
    catalog.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.name === "string",
    );
  if (!isValid) {
    console.error(
      "The downloaded file is not a non-empty array of { id, name } objects. Refusing to overwrite.",
    );
    process.exit(1);
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${catalog.length} exercises from ${REPO}@${ref}.`);
  console.log("Record this ref in src/data/README.md.");
};

run().catch((error) => {
  console.error("Catalog sync failed:", error);
  process.exit(1);
});
