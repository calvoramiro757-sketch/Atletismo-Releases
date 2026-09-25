'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const policy = require('../scripts/publisher-policy');
const apkInspection = require('../scripts/apk-inspection');

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const apk = Buffer.from('synthetic APK fixture - never published');
const apkSha = sha(apk);
const version = '3.4.4';
const updateUrl = `https://github.com/${policy.RELEASES_REPO}/releases/download/v${version}/Atletismo-release.apk`;
function metadata() {
  return {
    metadataVersion: 2, version, versionCode: 30318, channel: 'stable',
    publishedAt: '2026-09-25T00:00:00.000Z', minimumAppVersion: '3.4.0',
    dataSchema: 2, migrations: [], changelog: 'Synthetic fixture',
    android: { packageId: policy.PACKAGE_ID, minSdk: 24, abis: ['universal'], size: apk.length, sha256: apkSha, url: updateUrl }
  };
}
const checkMetadata = (value) => policy.validateMetadata(value, { version, apkSha256: apkSha, apkSize: apk.length });
const stable = () => ({ tag_name: 'v3.4.3', draft: false, prerelease: false });

test('real update.json contract: valid candidate and rejected mutations', () => {
  assert.equal(checkMetadata(metadata()), 30318);
  for (const [change, message] of [
    [(m) => { m.version = '3.4.3'; }, /version mismatch/],
    [(m) => { delete m.versionCode; }, /versionCode/],
    [(m) => { m.android.sha256 = '0'.repeat(64); }, /SHA-256 mismatch/],
    [(m) => { m.android.url += '?other=1'; }, /URL mismatch/],
    [(m) => { m.android.packageId = 'other.app'; }, /Package mismatch/],
    [(m) => { m.android.size++; }, /size mismatch/],
    [(m) => { m.channel = 'beta'; }, /Channel/],
    [(m) => { m.metadataVersion = 999; }, /metadataVersion/],
    [(m) => { m.dataSchema = 4; }, /dataSchema/],
    [(m) => { m.minimumAppVersion = 'invalid'; }, /version/],
    [(m) => { m.migrations = {}; }, /migrations/]
  ]) {
    const candidate = metadata();
    change(candidate);
    assert.throws(() => checkMetadata(candidate), message);
  }
});

test('Stable comparison requires both version and versionCode to increase', () => {
  const publicStable = { version: '3.4.3', versionCode: 30317, channel: 'stable' };
  for (const minimumAppVersion of ['3.4.0', '3.4.3']) {
    assert.doesNotThrow(() => policy.validateStable(stable(), publicStable, { version, versionCode: 30318, minimumAppVersion }));
  }
  assert.throws(() => policy.validateStable(stable(), publicStable, { version, versionCode: 30318, minimumAppVersion: '3.4.4' }), /minimumAppVersion/);
  assert.throws(() => policy.validateStable(stable(), publicStable, { version, versionCode: 30318, minimumAppVersion: '3.4.x' }), /Stable version/);
  assert.throws(() => policy.validateStable(stable(), publicStable, { version, versionCode: 30318 }), /Stable version/);
  for (const candidate of [
    { version, versionCode: 30317, minimumAppVersion: '3.4.0' },
    { version, versionCode: 30316, minimumAppVersion: '3.4.0' },
    { version: '3.4.2', versionCode: 30318, minimumAppVersion: '3.4.0' },
    { version: '3.4.3', versionCode: 30318, minimumAppVersion: '3.4.0' }
  ]) assert.throws(() => policy.validateStable(stable(), publicStable, candidate));
  assert.throws(() => policy.validateStable(stable(), { version: '3.4.3', channel: 'stable' }, { version, versionCode: 30318, minimumAppVersion: '3.4.0' }), /versionCode/);
  assert.throws(() => policy.validateStable({ ...stable(), draft: true }, publicStable, { version, versionCode: 30318, minimumAppVersion: '3.4.0' }));
});

test('only HTTP 404 proves release or tag absence', () => {
  for (const kind of ['release', 'tag']) {
    assert.doesNotThrow(() => policy.validateAbsenceStatus(404, kind));
    for (const status of [200, 401, 403, 429, 500, 503, 0]) assert.throws(() => policy.validateAbsenceStatus(status, kind));
  }
});

function evidence() {
  const started = '2026-09-25T12:00:00Z';
  const completed = '2026-09-25T12:10:00Z';
  const sourceSha = 'a'.repeat(40);
  const run = { id: 123, status: 'completed', conclusion: 'success', head_sha: sourceSha, path: '.github/workflows/build-release-apk.yml', run_attempt: 2, repository: { full_name: policy.SOURCE_REPO, id: 7 }, head_repository: { full_name: policy.SOURCE_REPO } };
  const job = { run_id: 123, head_sha: sourceSha, status: 'completed', conclusion: 'success', started_at: started, completed_at: completed, steps: [
    'Run regression tests', 'Build signed release APK', 'Verify signature and version metadata',
    'Upload APK', 'Verify V3.4.0 to current data preservation'
  ].map((name) => ({ name, conclusion: 'success' })) };
  const artifact = { id: 456, name: 'Atletismo-release-artifact', expired: false, size_in_bytes: 100, digest: 'sha256:' + 'b'.repeat(64), created_at: '2026-09-25T12:05:00Z', workflow_run: { id: 123, head_sha: sourceSha, repository_id: 7 } };
  return { run, jobs: { jobs: [job], total_count: 1 }, artifact, workflowBlob: policy.TRUSTED_SIGNED_WORKFLOW_BLOB, sourceSha, runId: '123', artifactId: '456' };
}

test('audited workflow, run, attempt and exact artifact are required', () => {
  assert.doesNotThrow(() => policy.validateEvidence(evidence()));
  for (const [change, message] of [
    [(e) => { e.workflowBlob = '0'.repeat(40); }, /not audited/],
    [(e) => { e.run.head_sha = '0'.repeat(40); }, /source SHA/],
    [(e) => { e.run.path = '.github/workflows/other.yml'; }, /path/],
    [(e) => { e.run.conclusion = 'failure'; }, /run failed/],
    [(e) => { e.run.run_attempt = null; }, /attempt/],
    [(e) => { e.artifact.id = 999; }, /Artifact ID/],
    [(e) => { e.artifact.expired = true; }, /expired/],
    [(e) => { e.artifact.created_at = '2026-09-25T11:00:00Z'; }, /run attempt/],
    [(e) => { e.jobs.jobs[0].steps[3].conclusion = 'failure'; }, /Signed step failed/]
  ]) {
    const value = evidence();
    change(value);
    assert.throws(() => policy.validateEvidence(value), message);
  }
});

test('file verifier rejects APK hash, update hash, and additional files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atletismo-publisher-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const update = JSON.stringify(metadata());
  fs.writeFileSync(path.join(dir, 'Atletismo-release.apk'), apk);
  fs.writeFileSync(path.join(dir, 'update.json'), update);
  const invoke = (apkHash, updateHash) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'files', dir, version, apkHash, updateHash], { encoding: 'utf8' });
  assert.equal(invoke(apkSha, sha(update)).status, 0);
  assert.equal(invoke('0'.repeat(64), sha(update)).status, 1);
  assert.equal(invoke(apkSha, '0'.repeat(64)).status, 1);
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'unexpected');
  assert.equal(invoke(apkSha, sha(update)).status, 1);
});

test('Stable metadata must be retrievable, authentic and unambiguous', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atletismo-stable-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stableFile = path.join(dir, 'stable-update.json');
  const latestFile = path.join(dir, 'latest.json');
  const candidateFile = path.join(dir, 'candidate-update.json');
  fs.writeFileSync(candidateFile, JSON.stringify(metadata()));
  const stableUpdate = JSON.stringify({ version: '3.4.3', versionCode: 30317, channel: 'stable' });
  fs.writeFileSync(stableFile, stableUpdate);
  const latest = { ...stable(), assets: [{
    name: 'update.json', size: Buffer.byteLength(stableUpdate), digest: 'sha256:' + sha(stableUpdate),
    browser_download_url: `https://github.com/${policy.RELEASES_REPO}/releases/download/v3.4.3/update.json`
  }] };
  const invoke = () => spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'stable', latestFile, stableFile, candidateFile], { encoding: 'utf8' });
  fs.writeFileSync(latestFile, JSON.stringify(latest));
  assert.equal(invoke().status, 0);
  fs.writeFileSync(candidateFile, JSON.stringify({ ...metadata(), minimumAppVersion: version }));
  assert.equal(invoke().status, 1);
  fs.writeFileSync(candidateFile, JSON.stringify(metadata()));
  fs.writeFileSync(stableFile, 'invalid');
  assert.equal(invoke().status, 1);
  fs.writeFileSync(stableFile, stableUpdate);
  fs.writeFileSync(latestFile, JSON.stringify({ ...latest, assets: [...latest.assets, latest.assets[0]] }));
  assert.equal(invoke().status, 1);
  fs.writeFileSync(latestFile, JSON.stringify(latest));
  fs.rmSync(stableFile);
  assert.equal(invoke().status, 1);
});

test('real APK badging is parsed strictly and compared with metadata and input', () => {
  const actual = apkInspection.parseApkBadging("package: name='com.atletismo.personal' versionCode='30318' versionName='3.4.4'\nsdkVersion:'24'\n");
  assert.deepEqual(actual, { packageId: 'com.atletismo.personal', versionCode: 30318, versionName: '3.4.4', minSdk: 24 });
  assert.doesNotThrow(() => apkInspection.validateApkIdentity(actual, metadata(), version));
  for (const [change, message] of [
    [(v) => { v.packageId = 'other.app'; }, /packageId/],
    [(v) => { v.versionName = '3.4.3'; }, /versionName/],
    [(v) => { v.versionCode = 30317; }, /versionCode/],
    [(v) => { v.minSdk = 25; }, /minSdk/]
  ]) {
    const altered = { ...actual };
    change(altered);
    assert.throws(() => apkInspection.validateApkIdentity(altered, metadata(), version), message);
  }
  assert.throws(() => apkInspection.parseApkBadging('not an APK'), /package identity/);
  assert.throws(() => apkInspection.parseApkBadging("package: name='com.atletismo.personal' versionCode='30318' versionName='3.4.4'\nsdkVersion:'24'\nsdkVersion:'25'\n"), /minimum SDK/);
});

test('only the audited official signing certificate is accepted', () => {
  const official = policy.OFFICIAL_SIGNING_CERT_SHA256;
  const output = (fingerprint, signerCount = 1) =>
    `Verifies\nNumber of signers: ${signerCount}\nSigner #1 certificate SHA-256 digest: ${fingerprint}\n`;
  assert.equal(apkInspection.parseSigningCertificate(output(official)), official);
  assert.doesNotThrow(() => apkInspection.validateSigningCertificate(official, official));

  const otherValidCertificate = 'a'.repeat(64);
  const parsedOther = apkInspection.parseSigningCertificate(output(otherValidCertificate));
  assert.throws(
    () => apkInspection.validateSigningCertificate(parsedOther, official),
    /official App Atletismo certificate/
  );
  assert.throws(() => apkInspection.parseSigningCertificate(output('not-a-sha256')), /cannot be parsed/);
  assert.throws(() => apkInspection.parseSigningCertificate('Verifies\nNumber of signers: 1\n'), /missing or ambiguous/);
  assert.throws(
    () => apkInspection.parseSigningCertificate(
      `Verifies\nNumber of signers: 2\nSigner #1 certificate SHA-256 digest: ${official}\nSigner #2 certificate SHA-256 digest: ${otherValidCertificate}\n`
    ),
    /exactly one signer/
  );
  assert.throws(() => apkInspection.validateSigningCertificate(official, 'broken'), /audited signing certificate/);
});

test('real aapt rejects fake bytes even if update.json declarations match', (t) => {
  const aapt = process.env.AAPT_TOOL || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'build-tools', '34.0.0', 'aapt.exe') : '');
  if (!aapt || !fs.existsSync(aapt)) return t.skip('aapt unavailable outside Android runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atletismo-fake-apk-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const apkFile = path.join(dir, 'Atletismo-release.apk');
  const updateFile = path.join(dir, 'update.json');
  fs.writeFileSync(apkFile, apk);
  fs.writeFileSync(updateFile, JSON.stringify(metadata()));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'apk', apkFile, updateFile, version, aapt], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Invalid APK or aapt failed/);
});

test('real apksigner rejects fake bytes before certificate identity parsing', (t) => {
  const apksigner = process.env.APKSIGNER_TOOL || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'build-tools', '34.0.0', 'apksigner.bat') : '');
  if (!apksigner || !fs.existsSync(apksigner)) return t.skip('apksigner unavailable outside Android runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atletismo-fake-signature-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const apkFile = path.join(dir, 'Atletismo-release.apk');
  fs.writeFileSync(apkFile, apk);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'certificate', apkFile, apksigner], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /APK signature verification failed/);
});

test('artifact archive accepts only the two exact root entries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atletismo-zip-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = path.join(dir, 'entries.txt');
  const invoke = () => spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'zip-entries', entries], { encoding: 'utf8' });
  fs.writeFileSync(entries, 'Atletismo-release.apk\nupdate.json\n');
  assert.equal(invoke().status, 0);
  fs.writeFileSync(entries, 'Atletismo-release.apk\nupdate.json\n../extra\n');
  assert.equal(invoke().status, 1);
});

test('draft and public release assets must exactly match', () => {
  const release = { tag_name: 'v3.4.4', draft: true, prerelease: false, assets: [
    { name: 'Atletismo-release.apk', digest: 'sha256:' + apkSha, size: apk.length, browser_download_url: updateUrl },
    { name: 'update.json', digest: 'sha256:' + 'c'.repeat(64), size: 100, browser_download_url: updateUrl.replace('Atletismo-release.apk', 'update.json') }
  ] };
  const expected = { version, apkSha256: apkSha, updateJsonSha256: 'c'.repeat(64), draft: true };
  assert.doesNotThrow(() => policy.validateReleaseAssets(release, expected));
  assert.throws(() => policy.validateReleaseAssets({ ...release, assets: [...release.assets, { name: 'extra' }] }, expected));
  assert.throws(() => policy.validateReleaseAssets(release, { ...expected, draft: false }));
  assert.throws(() => policy.validateReleaseAssets(release, { ...expected, apkSha256: '0'.repeat(64) }));
});

test('publication requires separate explicit confirmation; workflow has no automatic event', () => {
  assert.doesNotThrow(() => policy.validateAuthorization(true, false));
  assert.throws(() => policy.validateAuthorization(false, false), /confirmation/);
  assert.doesNotThrow(() => policy.validateAuthorization(false, true));
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-atletismo-release.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /environment: production-release/g);
  assert.match(workflow, /if: inputs.dry_run == false/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  const ci = fs.readFileSync(path.join(__dirname, '../.github/workflows/publisher-tests.yml'), 'utf8');
  for (const text of [workflow, ci]) {
    for (const [, ref] of text.matchAll(/uses:\s+actions\/[^@\s]+@([^\s]+)/g)) assert.match(ref, /^[a-f0-9]{40}$/);
    assert.doesNotMatch(text, /uses:\s+actions\/[^@\s]+@(v[0-9]|main|master)/);
  }
  assert.match(ci, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(ci, /sha256sum -c/);
});

test('all publisher bash blocks parse', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-atletismo-release.yml'), 'utf8').split(/\r?\n/);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)run: \|$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const block = [];
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() && line.match(/^ */)[0].length <= indent) { i--; break; }
      block.push(line.slice(indent + 2));
    }
    const result = spawnSync(bash, ['-n', '-c', block.join('\n')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    checked++;
  }
  assert.ok(checked >= 8, 'Expected publisher shell blocks were not found');
});
