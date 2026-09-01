#!/usr/bin/env node
/**
 * prepublishOnly hook: if the version in package.json is already on the
 * registry, bump to one patch above the highest published version so
 * `npm publish` never fails with a version conflict.
 *

 * npm snapshots the manifest BEFORE prepublishOnly runs, so a bump made
 * here would not make it into the tarball of the in-flight publish.
 * When invoked as prepublishOnly, this script therefore bumps on disk
 * and ABORTS the doomed publish with instructions to re-run; `npm run
 * release` chains bump + publish so it never aborts.
 * SIMULATE_PUBLISHED_VERSIONS (JSON array) overrides the registry
 * lookup for testing.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pkgPath = path.resolve(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

function publishedVersions(name) {
  if (process.env.SIMULATE_PUBLISHED_VERSIONS) {
    return JSON.parse(process.env.SIMULATE_PUBLISHED_VERSIONS);
  }
  let out;
  try {
    out = execSync(`npm view ${JSON.stringify(name)} versions --json`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // E404 = never published: no conflict possible. Anything else
    // (network down, auth) — don't guess, let npm publish surface it.
    if ((err.stdout ?? "").includes("E404") || (err.stderr ?? "").includes("E404")) {
      return [];
    }
    throw err;
  }
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Numeric compare of x.y.z release triples; prereleases sort below the
// same triple, which is close enough for picking the highest release.
function cmp(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return a.includes("-") === b.includes("-") ? 0 : a.includes("-") ? -1 : 1;
}

const versions = publishedVersions(pkg.name);
if (!versions.includes(pkg.version)) {
  console.log(`[auto-version] ${pkg.name}@${pkg.version} is free — publishing as is.`);
  process.exit(0);
}

const highest = versions.slice().sort(cmp).pop();
const [maj, min, patch] = highest.split("-")[0].split(".").map(Number);
const next = `${maj}.${min}.${patch + 1}`;

// npm version updates package.json and package-lock.json together.
execSync(`npm version ${next} --no-git-tag-version`, { stdio: "inherit" });
console.log(
  `[auto-version] ${pkg.name}@${pkg.version} already published (latest: ${highest}) — bumped to ${next}.`,
);

if (process.env.npm_lifecycle_event === "prepublishOnly") {
  // The publish that triggered us already snapshotted the old version;
  // letting it continue would push the stale manifest. Abort it — the
  // bump is saved, so the next publish goes through clean.
  console.error(
    `[auto-version] aborting this publish (npm already packed ${pkg.version}). Run npm publish again — it will publish ${next}.`,
  );
  process.exit(1);
}
