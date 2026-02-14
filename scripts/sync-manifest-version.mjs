#!/usr/bin/env node

import fs from 'node:fs';

function parseSemver(version) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!m) throw new Error(`Invalid semver: ${version}`);
  return version;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function main() {
  const pkgPath = 'package.json';
  const manifestPath = 'manifest.json';

  if (!fs.existsSync(pkgPath)) throw new Error('package.json not found');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found');

  const pkg = readJson(pkgPath);
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!version) throw new Error('package.json version is missing');
  parseSemver(version);

  const manifest = readJson(manifestPath);
  manifest.version = version;

  writeJson(manifestPath, manifest);
  process.stdout.write(`Synced manifest.json version to ${version}\n`);
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
