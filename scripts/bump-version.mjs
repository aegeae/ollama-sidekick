import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseSemver(version) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bump(current, kind) {
  const next = { ...current };
  if (kind === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
    return next;
  }
  if (kind === 'minor') {
    next.minor += 1;
    next.patch = 0;
    return next;
  }
  if (kind === 'patch') {
    next.patch += 1;
    return next;
  }
  return null;
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(path, obj) {
  const raw = JSON.stringify(obj, null, 2) + '\n';
  await writeFile(path, raw, 'utf8');
}

async function main() {
  const arg = (process.argv[2] ?? 'patch').trim();

  const pkgPath = new URL('../package.json', import.meta.url);
  const manifestPath = new URL('../manifest.json', import.meta.url);
  const lockPath = new URL('../package-lock.json', import.meta.url);

  const pkg = await readJson(pkgPath);
  const currentStr = String(pkg.version ?? '').trim();
  const current = parseSemver(currentStr);
  if (!current) fail(`package.json version is not valid semver (x.y.z): ${currentStr}`);

  let nextStr;
  const explicit = parseSemver(arg);
  if (explicit) {
    nextStr = formatSemver(explicit);
  } else {
    const bumped = bump(current, arg);
    if (!bumped) fail(`Unknown bump kind: ${arg}. Use patch|minor|major|x.y.z`);
    nextStr = formatSemver(bumped);
  }

  pkg.version = nextStr;
  await writeJson(pkgPath, pkg);

  const manifest = await readJson(manifestPath);
  manifest.version = nextStr;
  await writeJson(manifestPath, manifest);

  if (existsSync(lockPath)) {
    const lock = await readJson(lockPath);
    lock.version = nextStr;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = nextStr;
    }
    await writeJson(lockPath, lock);
  }

  console.log(nextStr);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
