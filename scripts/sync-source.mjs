#!/usr/bin/env node
// Release bookkeeping for the dsh-guard plugin.
//
//   node scripts/sync-source.mjs --record   run the matrix, then record lib/index.mjs in manifest.json
//   node scripts/sync-source.mjs --check    fail if lib/index.mjs no longer matches the manifest
//   node scripts/sync-source.mjs --write    copy the development-workspace copy in, then --record
//
// Why a manifest instead of a copy step: the plugin is developed inside a dsh workspace, where a
// forwarding module (`_dsh_guard/native/dsh-guard-native.mjs`) re-exports this project's file so the
// older paths keep working. Comparing the project against that shim would always report a difference,
// and comparing it against a *copy* would let two rule tables drift -- which is exactly how a rule
// silently stopped matching once (a `copy` literal that should have been `context`, hidden by a test
// that used the same wrong name). The manifest pins the revision that the matrix passed against, so
// "was this file tested?" is answerable from the repository alone.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const sourceFile = join(projectRoot, 'lib', 'index.mjs');
const manifestFile = join(projectRoot, 'manifest.json');
const matrixFile = join(projectRoot, 'test', 'matrix.mjs');
// Optional copy of lib/index.mjs kept in a development workspace. --write reads it from
// DSH_GUARD_WORKSPACE_COPY instead of a machine-specific default, so the release tooling works from
// any checkout; without the variable, --write explains and exits rather than guessing.
const workspaceCopy = process.env.DSH_GUARD_WORKSPACE_COPY || '';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readManifest = () => {
  try { return JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return undefined; }
};

const mode = process.argv[2] || '--check';

if (mode === '--record' || mode === '--record-verified') {
  if (!existsSync(sourceFile)) { console.error('missing ' + sourceFile); process.exit(2); }
  const manifest = readManifest() || { name: 'dsh-guard' };
  const previousHash = manifest.sha256 || '(none)';
  const outputHash = sha256(sourceFile);

  if (mode === '--record') {
    // Run the matrix with INHERITED stdio on purpose: capturing a child's output through a pipe is
    // blocked in a confined sandbox (`EPERM` on named pipes), and a plain `node scripts/... | ...`
    // invocation makes any piped child fail the same way. Inheritance also streams the test output
    // where the user is already looking.
    console.log('running the offline matrix (output below)...');
    const run = spawnSync(process.execPath, [matrixFile], { stdio: 'inherit' });
    if (run.error) {
      console.error('could not run the matrix: ' + run.error.message);
      console.error('run it yourself and then: node scripts/sync-source.mjs --record-verified');
      process.exit(1);
    }
    if (run.status !== 0) {
      console.error('the matrix failed (exit ' + run.status + '): refusing to record a revision that does not pass.');
      process.exit(1);
    }
    console.log('');
    console.log('matrix passed. Review its check count above, then record it explicitly:');
    console.log('  node scripts/sync-source.mjs --record-verified --checks <n>');
    process.exit(0);
  }

  // --record-verified: no child process at all. The caller has just seen the matrix pass.
  const flagIndex = process.argv.indexOf('--checks');
  const checks = flagIndex > -1 ? Number(process.argv[flagIndex + 1]) : (manifest.checks || 0);
  if (!Number.isFinite(checks) || checks <= 0) {
    console.error('need the verified check count: node scripts/sync-source.mjs --record-verified --checks 141');
    process.exit(2);
  }
  manifest.version = (() => {
    // One source of truth for the version: package.json. A manifest that lags it is how "-Status"
    // reports a version nobody shipped.
    try { return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version || manifest.version || '0.1.0'; }
    catch { return manifest.version || '0.1.0'; }
  })();
  manifest.source = 'lib/index.mjs';
  manifest.sha256 = outputHash;
  manifest.checks = checks;
  manifest.note = 'Recorded for the revision whose offline matrix passes. The installer verifies lib/index.mjs against this hash before copying it into a profile, and fails when the file has been edited without re-running the tests. Regenerate with: node scripts/sync-source.mjs --record then --record-verified --checks <n>';
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('recorded ' + outputHash + ' (' + checks + ' checks) in manifest.json');
  if (previousHash !== outputHash) console.log('NOTE: the source hash CHANGED (' + previousHash + ' -> ' + outputHash + ') -- redeploy with scripts/install.ps1');
  process.exit(0);
}

if (mode === '--write') {
  if (!workspaceCopy) {
    console.error('--write needs DSH_GUARD_WORKSPACE_COPY=<path to the development copy of dsh-guard-native.mjs>');
    process.exit(2);
  }
  if (!existsSync(workspaceCopy)) {
    console.error('development-workspace copy not found: ' + workspaceCopy);
    console.error('nothing copied; run --record if this project is the source of truth.');
    process.exit(2);
  }
  copyFileSync(workspaceCopy, sourceFile);
  console.log('copied ' + workspaceCopy + ' -> ' + sourceFile);
  const manifest = readManifest();
  console.log('now run: node scripts/sync-source.mjs --record');
  if (manifest && manifest.sha256 === sha256(sourceFile)) console.log('(content already matches the manifest)');
  process.exit(0);
}

if (mode === '--check') {
  const manifest = readManifest();
  if (!manifest || !manifest.sha256) {
    console.error('manifest.json is missing or has no sha256 -- run: node scripts/sync-source.mjs --record');
    process.exit(2);
  }
  const actual = sha256(sourceFile);
  const same = actual.toUpperCase() === String(manifest.sha256).toUpperCase();
  console.log('manifest (tested) : ' + manifest.sha256 + '  (' + (manifest.checks || '?') + ' checks)');
  console.log('lib/index.mjs     : ' + actual);
  console.log(same ? 'in sync: this is the revision the matrix passed against' : 'CHANGED since the manifest was recorded -- run the matrix, then: node scripts/sync-source.mjs --record');
  process.exit(same ? 0 : 1);
}

console.error('usage: node scripts/sync-source.mjs [--check|--record|--record-verified --checks <n>|--write]');
process.exit(2);
