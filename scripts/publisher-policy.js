'use strict';

const assert = require('node:assert/strict');

const SOURCE_REPO = 'calvoramiro757-sketch/Atletismo';
const RELEASES_REPO = 'calvoramiro757-sketch/Atletismo-Releases';
const PACKAGE_ID = 'com.atletismo.personal';
// Audited signed workflow with all external Actions pinned for future candidates.
// The historic V3.4.3 workflow blob is deliberately not trusted. Changes require audit.
const TRUSTED_SIGNED_WORKFLOW_BLOB = '28e1851e0afd279e876a315299907752665df46f';
// Extracted with apksigner --print-certs from V3.4.3 signed artifact 10873090249
// (signed run 36153245765, source 40e28c969b914724cecc74c05b973813f842e20c).
const OFFICIAL_SIGNING_CERT_SHA256 = '9dfe429d7de62570120a3d9f8f0026e55317f57bae4f9d8acbcab32941191ce5';
const SIGNED_WORKFLOW_PATH = '.github/workflows/build-release-apk.yml';
const ARTIFACT_NAME = 'Atletismo-release-artifact';
const FILES = ['Atletismo-release.apk', 'update.json'];
const SHA256 = /^[a-f0-9]{64}$/;

function versionParts(value) {
  assert.match(value, /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/, 'Invalid Stable version');
  return value.split('.').map(Number);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  }
  return 0;
}

function versionCode(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'Invalid versionCode');
  return value;
}

function validateMetadata(metadata, { version, apkSha256, apkSize }) {
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid update.json');
  versionParts(version);
  assert.equal(metadata.version, version, 'update.json version mismatch');
  versionCode(metadata.versionCode);
  assert.ok([1, 2].includes(metadata.metadataVersion), 'Unsupported metadataVersion');
  assert.equal(metadata.channel, 'stable', 'Channel must be stable');
  versionParts(metadata.minimumAppVersion);
  assert.ok(compareVersions(metadata.minimumAppVersion, version) <= 0, 'minimumAppVersion exceeds candidate');
  assert.ok(typeof metadata.changelog === 'string' && metadata.changelog.length <= 30000, 'Invalid changelog');
  assert.ok(typeof metadata.publishedAt === 'string' && metadata.publishedAt.length > 0 && metadata.publishedAt.length <= 64 && !Number.isNaN(Date.parse(metadata.publishedAt)), 'Invalid publishedAt');
  assert.ok(Array.isArray(metadata.migrations), 'Invalid migrations');
  if (metadata.dataSchema === 2) {
    assert.equal(metadata.migrations.length, 0, 'Schema 2 cannot declare migrations');
  } else {
    assert.equal(metadata.metadataVersion, 2, 'Schema 3 requires metadataVersion 2');
    assert.equal(metadata.dataSchema, 3, 'Unsupported dataSchema');
    assert.equal(metadata.migrations.length, 1, 'Schema 3 requires exactly one migration');
    const plan = metadata.migrations[0];
    assert.ok(plan && typeof plan === 'object' && !Array.isArray(plan), 'Invalid migration');
    assert.match(plan.id, /^[a-z][a-z0-9-]{2,80}$/, 'Invalid migration id');
    assert.equal(plan.fromSchema, 2, 'Invalid migration source schema');
    assert.equal(plan.toSchema, 3, 'Invalid migration target schema');
    assert.equal(plan.kind, 'additive', 'Only additive migration is supported');
    assert.equal(plan.requiresPreUpdateBackup, true, 'Migration requires pre-update backup');
  }
  const android = metadata.android;
  assert.ok(android && typeof android === 'object' && !Array.isArray(android), 'Missing android metadata');
  assert.equal(android.packageId, PACKAGE_ID, 'Package mismatch');
  assert.ok(Number.isInteger(android.minSdk) && android.minSdk >= 1 && android.minSdk <= 35, 'Invalid minSdk');
  assert.ok(Array.isArray(android.abis) && android.abis.includes('universal'), 'APK must support universal ABI');
  assert.ok(Number.isSafeInteger(apkSize) && apkSize > 0 && apkSize <= 512 * 1024 * 1024, 'Invalid APK size');
  assert.equal(android.size, apkSize, 'APK size mismatch');
  assert.match(android.sha256, SHA256, 'Invalid android.sha256');
  assert.equal(android.sha256, apkSha256, 'APK SHA-256 mismatch');
  assert.equal(android.url, `https://github.com/${RELEASES_REPO}/releases/download/v${version}/Atletismo-release.apk`, 'APK URL mismatch');
  return metadata.versionCode;
}

function validateStable(latest, stableMetadata, candidate) {
  assert.ok(latest && latest.draft === false && latest.prerelease === false, 'Latest release is not public Stable');
  assert.match(latest.tag_name, /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/, 'Invalid latest tag');
  const stableVersion = latest.tag_name.slice(1);
  assert.equal(stableMetadata.version, stableVersion, 'Stable metadata/tag mismatch');
  assert.equal(stableMetadata.channel, 'stable', 'Latest release is not Stable');
  versionCode(stableMetadata.versionCode);
  assert.ok(compareVersions(candidate.version, stableVersion) > 0, 'Candidate version is not newer than Stable');
  assert.ok(versionCode(candidate.versionCode) > stableMetadata.versionCode, 'Candidate versionCode is not newer than Stable');
  versionParts(candidate.minimumAppVersion);
  assert.ok(compareVersions(candidate.minimumAppVersion, stableVersion) <= 0, 'Candidate minimumAppVersion blocks the public Stable');
}

function validateAbsenceStatus(status, kind) {
  assert.ok(['release', 'tag'].includes(kind), 'Invalid target kind');
  if (status === 404) return;
  if (status === 200) throw new Error(`Target ${kind} already exists`);
  throw new Error(`Cannot prove target ${kind} absent: HTTP ${status}`);
}

function validateEvidence({ run, jobs, artifact, workflowBlob, sourceSha, runId, artifactId }) {
  assert.equal(workflowBlob, TRUSTED_SIGNED_WORKFLOW_BLOB, 'Signed workflow blob is not audited');
  assert.equal(String(run.id), String(runId), 'Signed run ID mismatch');
  assert.equal(run.status, 'completed', 'Signed run incomplete');
  assert.equal(run.conclusion, 'success', 'Signed run failed');
  assert.equal(run.head_sha, sourceSha, 'Signed run source SHA mismatch');
  assert.equal(run.path, SIGNED_WORKFLOW_PATH, 'Signed workflow path mismatch');
  assert.equal(run.repository?.full_name, SOURCE_REPO, 'Signed run repository mismatch');
  assert.equal(run.head_repository?.full_name, SOURCE_REPO, 'Signed run head repository mismatch');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing signed run attempt');
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length === 1 && jobs.total_count === 1, 'Ambiguous signed run jobs');
  const job = jobs.jobs[0];
  assert.equal(job.run_id, run.id, 'Job run mismatch');
  assert.equal(job.head_sha, sourceSha, 'Job source mismatch');
  assert.equal(job.status, 'completed', 'Signed job incomplete');
  assert.equal(job.conclusion, 'success', 'Signed job failed');
  assert.ok(Array.isArray(job.steps), 'Signed job steps unavailable');
  for (const name of ['Run regression tests', 'Build signed release APK', 'Verify signature and version metadata', 'Upload APK', 'Verify V3.4.0 to current data preservation']) {
    const matching = job.steps.filter((step) => step.name === name);
    assert.equal(matching.length, 1, `Missing or duplicate signed step: ${name}`);
    assert.equal(matching[0].conclusion, 'success', `Signed step failed: ${name}`);
  }
  assert.equal(String(artifact.id), String(artifactId), 'Artifact ID mismatch');
  assert.equal(artifact.name, ARTIFACT_NAME, 'Unexpected artifact name');
  assert.equal(artifact.expired, false, 'Artifact expired');
  assert.equal(artifact.workflow_run?.id, run.id, 'Artifact belongs to another run');
  assert.equal(artifact.workflow_run?.head_sha, sourceSha, 'Artifact source mismatch');
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id, 'Artifact repository mismatch');
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/, 'Missing artifact archive digest');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 512 * 1024 * 1024, 'Invalid artifact archive size');
  const created = Date.parse(artifact.created_at);
  const started = Date.parse(job.started_at);
  const completed = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed) && created >= started && created <= completed, 'Artifact was not created by this run attempt');
  return { attempt: run.run_attempt, artifactDigest: artifact.digest };
}

function validateReleaseAssets(release, { version, apkSha256, updateJsonSha256, draft }) {
  assert.equal(release.tag_name, `v${version}`, 'Release tag mismatch');
  assert.equal(release.draft, draft, 'Release draft status mismatch');
  assert.equal(release.prerelease, false, 'Release is prerelease');
  const assets = release.assets;
  assert.ok(Array.isArray(assets) && assets.length === 2, 'Release must have exactly two assets');
  assert.deepEqual(assets.map((asset) => asset.name).sort(), [...FILES].sort(), 'Release asset names mismatch');
  for (const asset of assets) {
    const expected = asset.name === FILES[0] ? apkSha256 : updateJsonSha256;
    assert.equal(asset.digest, `sha256:${expected}`, `Published digest mismatch: ${asset.name}`);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid release asset size');
    assert.equal(asset.browser_download_url, `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${asset.name}`, 'Release asset URL mismatch');
  }
}

function validateAuthorization(dryRun, publishConfirm) {
  assert.ok(typeof dryRun === 'boolean' && typeof publishConfirm === 'boolean', 'Invalid publication flags');
  if (!dryRun) assert.equal(publishConfirm, true, 'Publication requires explicit confirmation');
}

module.exports = { SOURCE_REPO, RELEASES_REPO, PACKAGE_ID, FILES, TRUSTED_SIGNED_WORKFLOW_BLOB, OFFICIAL_SIGNING_CERT_SHA256, compareVersions, validateMetadata, validateStable, validateAbsenceStatus, validateEvidence, validateReleaseAssets, validateAuthorization };
