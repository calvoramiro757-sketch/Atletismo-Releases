'use strict';

const assert = require('node:assert/strict');

const SOURCE_REPO = 'calvoramiro757-sketch/Atletismo';
const RELEASES_REPO = 'calvoramiro757-sketch/Atletismo-Releases';
const PACKAGE_ID = 'com.atletismo.personal';
// Audited signed workflow with all external Actions pinned for future candidates.
// The historic V3.4.3 workflow blob is deliberately not trusted. Changes require audit.
const TRUSTED_SIGNED_WORKFLOW_BLOB = '9a2ca9b3903ce8e07325baf72f3859f7ab566de6';
// Extracted with apksigner --print-certs from V3.4.3 signed artifact 10873090249
// (signed run 36153245765, source 40e28c969b914724cecc74c05b973813f842e20c).
const OFFICIAL_SIGNING_CERT_SHA256 = '9dfe429d7de62570120a3d9f8f0026e55317f57bae4f9d8acbcab32941191ce5';
const SIGNED_WORKFLOW_PATH = '.github/workflows/build-release-apk.yml';
const ARTIFACT_NAME = 'Atletismo-release-artifact';
const FILES = ['Atletismo-release.apk', 'update.json'];
const SHA256 = /^[a-f0-9]{64}$/;
const V344_RECOVERY = Object.freeze({
  version: '3.4.4',
  sourceSha: '147960406da1631e388ec2ff5c501dfb31759598',
  metadataSourceSha: 'b7b87b60afe94bd97be554e9b5c74b7a8459b685',
  signedRunId: '36276925417',
  artifactId: '10917702155',
  tagSha: '1cf5428dae7e04f144eff9b75c5f56c720204598',
  releaseId: 397433395,
  apkAssetId: 591683598,
  oldUpdateAssetId: 591683601,
  oldUpdateSize: 1619,
  apkSha256: 'dfcdda35f7c4e92b445fe38f9f6545003db870ffbb982c140276129aa0c06364',
  oldUpdateSha256: '8ce9761b8fa0d5a78a531350b0883546000d2043f864994dbf4ea604f01dd4fd',
  newUpdateSha256: '4ea5fdfdc0827854bae4c4d2d273153f0beeccd52f5b961650a61dd21a193bd0'
});

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
    const publicUrl = `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${asset.name}`;
    const draftSlug = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/(untagged-[a-f0-9]+)$/.exec(release.html_url || '');
    const draftUrl = draftSlug && `https://github.com/${RELEASES_REPO}/releases/download/${draftSlug[1]}/${asset.name}`;
    assert.ok(asset.browser_download_url === publicUrl || (draft && asset.browser_download_url === draftUrl), 'Release asset URL mismatch');
  }
}

function stableChangelog(source, version) {
  assert.ok(typeof source === 'string', 'Changelog source unavailable');
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\nreleaseStatus: (development|stable-ready)\nversion: ([0-9]+\.[0-9]+\.[0-9]+)\n---\n([\s\S]+)$/.exec(normalized);
  assert.ok(match, 'Changelog source lacks structured release status');
  assert.equal(match[1], 'stable-ready', 'Development changelog cannot be published as Stable');
  assert.equal(match[2], version, 'Changelog source version mismatch');
  assert.ok(match[3].startsWith(`# V${version} — `), 'Changelog title mismatch');
  return match[3];
}

function repairMetadata(original, changelogSource, version) {
  assert.ok(original && typeof original === 'object' && !Array.isArray(original), 'Invalid original metadata');
  assert.equal(original.version, version, 'Original metadata version mismatch');
  const updated = { ...original, changelog: stableChangelog(changelogSource, version) };
  return JSON.stringify(updated, null, 2) + '\n';
}

function validateMetadataSource(candidate, changelogSource, version) {
  assert.equal(candidate.changelog, stableChangelog(changelogSource, version), 'Candidate changelog differs from audited Stable source');
}

function validateRecoveryInputs(input) {
  for (const key of ['version', 'sourceSha', 'metadataSourceSha', 'signedRunId', 'artifactId', 'tagSha', 'apkSha256', 'oldUpdateSha256', 'newUpdateSha256']) {
    assert.equal(String(input[key]), String(V344_RECOVERY[key]), `V3.4.4 recovery ${key} mismatch`);
  }
}

function validateCandidateProvenance(input) {
  assert.match(input.sourceSha, /^[a-f0-9]{40}$/, 'Invalid source SHA');
  assert.match(input.metadataSourceSha, /^[a-f0-9]{40}$/, 'Invalid metadata source SHA');
  assert.match(input.apkSha256, SHA256, 'Invalid APK hash');
  assert.match(input.oldUpdateSha256, SHA256, 'Invalid signed metadata hash');
  assert.match(input.newUpdateSha256, SHA256, 'Invalid candidate metadata hash');
  if (input.version === V344_RECOVERY.version) {
    validateRecoveryInputs(input);
    return true;
  }
  assert.equal(input.metadataSourceSha, input.sourceSha, 'Future metadata source must be the signed source commit');
  assert.equal(input.oldUpdateSha256, input.newUpdateSha256, 'Future signed artifact must contain final metadata');
  return false;
}

function releaseNotes({ sourceSha, signedRunId, artifactId, apkSha256, updateJsonSha256, publisherSha, metadataSourceSha, replacedUpdateSha256 }) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'Invalid source SHA');
  assert.match(String(signedRunId), /^[1-9][0-9]*$/, 'Invalid signed run ID');
  assert.match(String(artifactId), /^[1-9][0-9]*$/, 'Invalid artifact ID');
  assert.match(apkSha256, SHA256, 'Invalid APK hash');
  assert.match(updateJsonSha256, SHA256, 'Invalid update hash');
  if (publisherSha !== undefined) assert.match(publisherSha, /^[a-f0-9]{40}$/, 'Invalid publisher SHA');
  if (metadataSourceSha !== undefined) assert.match(metadataSourceSha, /^[a-f0-9]{40}$/, 'Invalid metadata source SHA');
  if (replacedUpdateSha256 !== undefined) assert.match(replacedUpdateSha256, SHA256, 'Invalid replaced update hash');
  return [
    `Source SHA: ${sourceSha}`,
    ...(metadataSourceSha ? [`Metadata source SHA: ${metadataSourceSha}`] : []),
    `Signed run: https://github.com/${SOURCE_REPO}/actions/runs/${signedRunId}`,
    `Artifact ID: ${artifactId}`,
    `APK SHA-256: ${apkSha256}`,
    `update.json SHA-256: ${updateJsonSha256}`,
    ...(publisherSha ? [`Publisher SHA: ${publisherSha}`] : []),
    ...(replacedUpdateSha256 ? [`Replaced defective update.json SHA-256: ${replacedUpdateSha256}`] : [])
  ].join('\n') + '\n';
}

// This function consumes a complete, authenticated release list. A 404 from
// releases/tags is not evidence of draft absence: GitHub gives drafts an
// untagged-* URL until publication.
function reconcileReleaseState({ tag, releases, latest, expected }) {
  const { version, tagSha, apkSha256, updateJsonSha256, apkSize, updateJsonSize, notes, recovery } = expected;
  versionParts(version);
  assert.match(tagSha, /^[a-f0-9]{40}$/, 'Invalid expected tag SHA');
  assert.ok(Array.isArray(releases), 'Authenticated release list unavailable');
  assert.ok(latest && typeof latest === 'object', 'Latest release unavailable');
  const ref = `refs/tags/v${version}`;
  if (tag !== null) {
    assert.equal(tag.ref, ref, 'Tag ref mismatch');
    assert.equal(tag.object?.type, 'commit', 'Tag must point directly to a commit');
    assert.equal(tag.object.sha, tagSha, 'Tag points to unexpected commit');
  }
  const matching = releases.filter((release) => release.tag_name === `v${version}`);
  assert.ok(matching.length <= 1, 'Duplicate releases for version');
  const release = matching[0] || null;
  assert.equal(releases.filter((item) => item.name === `App Atletismo V${version}`).length, release ? 1 : 0, 'Duplicate release title');
  if (release === null) {
    assert.ok(!recovery, 'V3.4.4 recovery draft is missing');
    return { action: tag ? 'create-draft' : 'create-tag' };
  }
  assert.ok(tag, 'Release exists without expected tag');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Release ID missing');
  if (recovery) assert.equal(release.id, V344_RECOVERY.releaseId, 'Unexpected recovery release ID');
  assert.equal(release.name, `App Atletismo V${version}`, 'Release title mismatch');
  assert.equal(release.target_commitish, recovery ? 'main' : tagSha, 'Release target commit mismatch');
  const legacyNotes = recovery && releaseNotes({ sourceSha: V344_RECOVERY.sourceSha, signedRunId: V344_RECOVERY.signedRunId, artifactId: V344_RECOVERY.artifactId, apkSha256: V344_RECOVERY.apkSha256, updateJsonSha256: V344_RECOVERY.oldUpdateSha256 });
  const legacyBody = recovery && release.body === legacyNotes;
  assert.ok(release.body === notes || legacyBody, 'Release provenance notes mismatch');
  assert.equal(release.prerelease, false, 'Release is prerelease');
  assert.ok(Array.isArray(release.assets), 'Release assets unavailable');
  assert.ok(release.assets.length <= FILES.length, 'Unexpected or duplicate release assets');
  const missing = [];
  let oldMetadata = false;
  for (const name of FILES) {
    const assets = release.assets.filter((asset) => asset.name === name);
    assert.ok(assets.length <= 1, `Duplicate ${name} asset`);
    if (assets.length === 0) { missing.push(name); continue; }
    const asset = assets[0];
    assert.equal(asset.state, 'uploaded', `Asset ${name} is not uploaded`);
    const publicUrl = `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${name}`;
    const slug = /^https:\/\/github\.com\/calvoramiro757-sketch\/Atletismo-Releases\/releases\/tag\/(untagged-[a-f0-9]+)$/.exec(release.html_url || '');
    const draftUrl = slug && `https://github.com/${RELEASES_REPO}/releases/download/${slug[1]}/${name}`;
    assert.ok(asset.browser_download_url === publicUrl || (release.draft && asset.browser_download_url === draftUrl), `Asset ${name} URL mismatch`);
    const digest = name === FILES[0] ? apkSha256 : updateJsonSha256;
    const size = name === FILES[0] ? apkSize : updateJsonSize;
    if (recovery && name === FILES[0]) assert.equal(asset.id, V344_RECOVERY.apkAssetId, 'Recovery APK asset ID mismatch');
    if (recovery && name === FILES[1] && asset.id === V344_RECOVERY.oldUpdateAssetId) {
      assert.ok(release.draft, 'Defective metadata cannot be public');
      assert.equal(asset.digest, `sha256:${V344_RECOVERY.oldUpdateSha256}`, 'Historic defective metadata changed');
      assert.equal(asset.size, V344_RECOVERY.oldUpdateSize, 'Historic defective metadata size changed');
      assert.ok(legacyBody, 'Historic metadata requires historic release notes');
      oldMetadata = true;
      continue;
    }
    assert.equal(asset.digest, `sha256:${digest}`, `Unexpected ${name} digest`);
    assert.equal(asset.size, size, `Unexpected ${name} size`);
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, `Invalid ${name} asset ID`);
  }
  assert.deepEqual(release.assets.map((asset) => asset.name).sort(), FILES.filter((name) => !missing.includes(name)).sort(), 'Unexpected release asset');
  if (oldMetadata) {
    assert.deepEqual(missing, [], 'Recovery draft is missing its APK');
    return { action: 'repair-metadata', releaseId: release.id, oldAssetId: V344_RECOVERY.oldUpdateAssetId, missing: [] };
  }
  if (release.draft) {
    if (missing.length) return { action: 'upload-assets', releaseId: release.id, missing };
    if (legacyBody) return { action: 'update-notes', releaseId: release.id, missing: [] };
    return { action: 'promote', releaseId: release.id, missing: [] };
  }
  assert.deepEqual(missing, [], 'Public release is incomplete');
  assert.equal(latest.id, release.id, 'An older publication cannot supersede latest');
  return { action: 'complete', releaseId: release.id, missing: [] };
}

function validateAuthorization(dryRun, publishConfirm) {
  assert.ok(typeof dryRun === 'boolean' && typeof publishConfirm === 'boolean', 'Invalid publication flags');
  if (!dryRun) assert.equal(publishConfirm, true, 'Publication requires explicit confirmation');
}

module.exports = { SOURCE_REPO, RELEASES_REPO, PACKAGE_ID, FILES, TRUSTED_SIGNED_WORKFLOW_BLOB, OFFICIAL_SIGNING_CERT_SHA256, V344_RECOVERY, compareVersions, validateMetadata, validateStable, validateAbsenceStatus, validateEvidence, validateReleaseAssets, validateAuthorization, releaseNotes, reconcileReleaseState, stableChangelog, repairMetadata, validateMetadataSource, validateRecoveryInputs, validateCandidateProvenance };
