/**
 * Framework packager: builds the framework ZIP (flat root: manifest.json,
 * config.json, onboarding.json, base/ + parts) and the update-channel
 * index.json (version / url / sha256 [+ min_app_version]) beside it.
 *
 * Mirrors the app's expectations exactly (`framework_updater.rs` reads the
 * index; `package_import.rs` reads the zip). Output goes to <root>/dist/
 * by default: dist/<id>.zip + dist/index.json.
 */

import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const EXCLUDE = new Set([
  "dist", ".git", ".dev", ".github", ".agents", "tools", "node_modules",
  "README.md", "AGENTS.md", "skills-lock.json",
  // Repo tooling manifests/lockfiles — never framework content.
  "package.json", "package-lock.json", "bun.lock", "bun.lockb",
  "pnpm-lock.yaml", "yarn.lock",
]);

export function pack(rootArg: string, outDirArg?: string): number {
  const root = resolve(rootArg);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${manifestPath}. A framework requires a root manifest.json.`);
    return 1;
  }
  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    console.error(`manifest.json is not valid JSON: ${e}`);
    return 1;
  }
  for (const field of ["id", "name", "description", "version"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      console.error(`manifest.json is missing required field: "${field}"`);
      return 1;
    }
  }
  if (!statSync(join(root, "base"), { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Missing ${join(root, "base")}. The layout requires a base/ folder.`);
    return 1;
  }

  const zipName = `${manifest.id}.zip`;
  const outDir = resolve(outDirArg ?? join(root, "dist"));
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, zipName);
  const indexPath = join(outDir, "index.json");

  const zip = new AdmZip();
  for (const entry of readdirSync(root)) {
    if (EXCLUDE.has(entry)) continue;
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) zip.addLocalFolder(fullPath, entry);
    else zip.addLocalFile(fullPath);
  }
  zip.writeZip(outputPath);

  const sha256 = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
  const index: Record<string, string> = {
    version: manifest.version,
    // Relative to the index document — upload both side by side.
    url: `./${zipName}`,
    sha256,
    description: manifest.description,
  };
  if (typeof manifest.min_app_version === "string" && manifest.min_app_version) {
    index.min_app_version = manifest.min_app_version;
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

  console.log(`Created ${outputPath}`);
  console.log(`Created ${indexPath}`);
  console.log(`version   ${manifest.version}`);
  console.log(`sha256    ${sha256}`);
  return 0;
}
