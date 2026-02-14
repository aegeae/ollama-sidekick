#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/apply-version.mjs <version> [--manifest <path>]');
  process.exit(2);
}

function parseSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return version;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function findDefaultManifestPath() {
  const candidates = ['public/manifest.json', 'manifest.json'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find manifest. Pass --manifest <path>.');
}

function parseArgs(argv) {
  if (argv.length < 1) usage();
  if (argv[0] === '--help' || argv[0] === '-h') usage();

  const version = argv[0];
  let manifestPath = null;

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') {
      const v = argv[i + 1];
      if (!v) usage();
      manifestPath = v;
      i += 1;
      continue;
    }
    if (a === '-h' || a === '--help') usage();

    throw new Error(`Unknown arg: ${a}`);
  }

  return { version, manifestPath };
}

function main() {
  const { version, manifestPath } = parseArgs(process.argv.slice(2));
  const nextVersion = parseSemver(version);

  const pkgPath = 'package.json';
  if (!fs.existsSync(pkgPath)) throw new Error('package.json not found');

  const resolvedManifestPath = manifestPath ?? findDefaultManifestPath();
  if (!fs.existsSync(resolvedManifestPath)) {
    throw new Error(`Manifest not found: ${resolvedManifestPath}`);
  }

  const pkg = readJson(pkgPath);
  pkg.version = nextVersion;
  writeJson(pkgPath, pkg);

  const manifest = readJson(resolvedManifestPath);
  manifest.version = nextVersion;
  writeJson(resolvedManifestPath, manifest);

  // Keep package-lock in sync if present (npm uses it in releases)
  const lockPath = 'package-lock.json';
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = nextVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = nextVersion;
    }
    writeJson(lockPath, lock);
  }

  const touched = [pkgPath, resolvedManifestPath].concat(fs.existsSync('package-lock.json') ? ['package-lock.json'] : []);
  process.stdout.write(`Applied version ${nextVersion} to: ${touched.join(', ')}\n`);
}

main();
