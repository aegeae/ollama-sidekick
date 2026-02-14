#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function safeSh(cmd) {
  try {
    return { ok: true, out: sh(cmd) };
  } catch (err) {
    return { ok: false, out: '' };
  }
}

function parseSemver(version) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!m) throw new Error(`Invalid semver: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bumpSemver(version, bump) {
  const v = parseSemver(version);
  if (bump === 'major') return `${v.major + 1}.0.0`;
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (bump === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  if (bump === 'none') return version;
  throw new Error(`Unknown bump: ${bump}`);
}

function readPackageVersion() {
  const pkgPath = 'package.json';
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!version) return null;
  parseSemver(version);
  return version;
}

function findLatestTag() {
  // Version-aware sort (works well for vX.Y.Z tags)
  const res = safeSh("git tag --list 'v*' --sort=-v:refname");
  if (!res.ok || !res.out) return null;
  const [first] = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return first || null;
}

function versionFromTag(tag) {
  const m = /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(tag);
  if (!m) return null;
  return m[1];
}

function getCommitMessagesSince(tag) {
  // Collect full message (subject+body) for each commit.
  // If no tag exists, scan the whole history.
  const rangeArg = tag ? `${tag}..HEAD` : '';
  const out = sh(`git log ${rangeArg} --format=%B%n----END-COMMIT----`);
  const chunks = out
    .split('----END-COMMIT----')
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks;
}

function computeBump(messages) {
  let bump = 'none';

  const consider = (candidate) => {
    const order = { none: 0, patch: 1, minor: 2, major: 3 };
    if (order[candidate] > order[bump]) bump = candidate;
  };

  for (const msg of messages) {
    const lines = msg.split(/\r?\n/);
    const subject = (lines[0] || '').trim();

    // Ignore auto-generated release commits.
    if (/^chore\(release\):/.test(subject)) continue;

    const isBreakingByFooter = /(^|\n)BREAKING CHANGE:\s*/.test(msg);
    const isBreakingByBang = /^\w+(\([^)]*\))?!:/.test(subject);
    if (isBreakingByFooter || isBreakingByBang) {
      consider('major');
      continue;
    }

    // Conventional commit type detection from subject line
    if (/^feat(\([^)]*\))?:/.test(subject)) {
      consider('minor');
      continue;
    }
    if (/^fix(\([^)]*\))?:/.test(subject)) {
      consider('patch');
      continue;
    }
  }

  return bump;
}

function parseArgs(argv) {
  return {
    githubOutput: argv.includes('--github-output'),
    json: argv.includes('--json') || argv.includes('--github-output'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const latestTag = findLatestTag();
  const pkgVersion = readPackageVersion();
  const baseVersion = latestTag ? (versionFromTag(latestTag) ?? '0.0.0') : (pkgVersion ?? '0.0.0');
  const shouldTagBase = latestTag == null;

  const messages = getCommitMessagesSince(latestTag);
  const bump = computeBump(messages);

  const nextVersion = bumpSemver(baseVersion, bump);
  const nextTag = `v${nextVersion}`;

  const result = {
    lastTag: latestTag,
    baseVersion,
    shouldTagBase,
    bump,
    version: nextVersion,
    tag: nextTag,
    commitCount: messages.length,
  };

  if (args.githubOutput) {
    const outFile = process.env.GITHUB_OUTPUT;
    if (!outFile) throw new Error('GITHUB_OUTPUT is not set');
    // Use a single-line JSON output as well as individual fields.
    fs.appendFileSync(outFile, `bump=${result.bump}\n`);
    fs.appendFileSync(outFile, `version=${result.version}\n`);
    fs.appendFileSync(outFile, `tag=${result.tag}\n`);
    fs.appendFileSync(outFile, `should_tag_base=${result.shouldTagBase}\n`);
    fs.appendFileSync(outFile, `last_tag=${result.lastTag ?? ''}\n`);
    fs.appendFileSync(outFile, `base_version=${result.baseVersion}\n`);
    fs.appendFileSync(outFile, `commit_count=${result.commitCount}\n`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      [
        `lastTag: ${result.lastTag ?? '(none)'}`,
        `baseVersion: ${result.baseVersion}`,
        `commits: ${result.commitCount}`,
        `bump: ${result.bump}`,
        `next: ${result.tag}`,
      ].join('\n') +
        '\n'
    );
  }
}

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
