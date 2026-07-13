#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist"]);

function findPackageManifests(directory) {
  const manifests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...findPackageManifests(path));
    } else if (entry.name === "package.json") {
      manifests.push(path);
    }
  }
  return manifests;
}

const packages = new Map();
for (const manifestPath of findPackageManifests(repositoryRoot)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name) packages.set(manifest.name, { manifest, manifestPath });
}

const runtimePackages = new Set(["@paperclipai/server"]);
const pending = [...runtimePackages];
while (pending.length > 0) {
  const packageName = pending.pop();
  const entry = packages.get(packageName);
  if (!entry) throw new Error(`Missing workspace package ${packageName}`);
  for (const [dependency, version] of Object.entries(entry.manifest.dependencies ?? {})) {
    if (!String(version).startsWith("workspace:")) continue;
    if (!runtimePackages.has(dependency)) {
      runtimePackages.add(dependency);
      pending.push(dependency);
    }
  }
}

for (const packageName of [...runtimePackages].sort()) {
  const entry = packages.get(packageName);
  const publishConfig = entry.manifest.publishConfig;
  if (!publishConfig?.exports) {
    throw new Error(`${packageName} does not declare compiled publish exports`);
  }

  const packageDirectory = dirname(entry.manifestPath);
  if (!existsSync(join(packageDirectory, "dist"))) {
    throw new Error(`${packageName} has no compiled dist directory`);
  }

  entry.manifest.exports = publishConfig.exports;
  if (publishConfig.main) entry.manifest.main = publishConfig.main;
  if (publishConfig.types) entry.manifest.types = publishConfig.types;
  delete entry.manifest.devDependencies;
  delete entry.manifest.scripts;
  writeFileSync(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`);
}

console.log(
  `Prepared ${runtimePackages.size} compiled runtime packages: ${[...runtimePackages]
    .sort()
    .map((name) => relative(repositoryRoot, packages.get(name).manifestPath))
    .join(", ")}`,
);
