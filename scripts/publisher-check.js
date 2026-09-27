'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const policy = require('./publisher-policy');
const apkInspection = require('./apk-inspection');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const [mode, ...args] = process.argv.slice(2);

try {
  if (mode === 'authorization') {
    policy.validateAuthorization(args[0] === 'true', args[1] === 'true');
    assert.ok(['true', 'false'].includes(args[0]) && ['true', 'false'].includes(args[1]), 'Invalid booleans');
  } else if (mode === 'absence') {
    policy.validateAbsenceStatus(Number(args[0]), args[1]);
  } else if (mode === 'zip-entries') {
    assert.deepEqual(fs.readFileSync(args[0], 'utf8').trimEnd().split(/\r?\n/).sort(), [...policy.FILES].sort(), 'Artifact ZIP must contain exactly the two root files');
  } else if (mode === 'evidence') {
    const [runFile, jobsFile, artifactFile, blobFile, sourceSha, runId, artifactId, digestFile] = args;
    const result = policy.validateEvidence({
      run: read(runFile), jobs: read(jobsFile), artifact: read(artifactFile),
      workflowBlob: fs.readFileSync(blobFile, 'utf8').trim(), sourceSha, runId, artifactId
    });
    fs.writeFileSync(digestFile, result.artifactDigest.slice('sha256:'.length) + '\n');
    console.log(`Signed attempt ${result.attempt} and exact artifact verified`);
  } else if (mode === 'files') {
    const [directory, version, apkSha256, updateJsonSha256] = args;
    assert.match(apkSha256, /^[a-f0-9]{64}$/, 'Invalid expected APK hash');
    assert.match(updateJsonSha256, /^[a-f0-9]{64}$/, 'Invalid expected metadata hash');
    assert.deepEqual(fs.readdirSync(directory).sort(), [...policy.FILES].sort(), 'Artifact must contain exactly two files');
    for (const file of policy.FILES) {
      const stat = fs.lstatSync(path.join(directory, file));
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Invalid artifact file: ${file}`);
    }
    const apk = path.join(directory, policy.FILES[0]);
    const update = path.join(directory, policy.FILES[1]);
    assert.equal(hash(apk), apkSha256, 'APK hash mismatch');
    assert.equal(hash(update), updateJsonSha256, 'update.json hash mismatch');
    policy.validateMetadata(read(update), { version, apkSha256, apkSize: fs.statSync(apk).size });
    console.log('Exact files, hashes and update.json contract verified');
  } else if (mode === 'recovery-tag') {
    const tag = read(args[0]);
    assert.equal(tag.ref, 'refs/tags/v3.4.4', 'V3.4.4 recovery tag ref mismatch');
    assert.equal(tag.object?.type, 'commit', 'V3.4.4 recovery tag must point directly to a commit');
    assert.equal(tag.object.sha, policy.V344_RECOVERY.tagSha, 'V3.4.4 recovery tag SHA mismatch');
    console.log(`Historic V3.4.4 tag verified: ${tag.object.sha}`);
  } else if (mode === 'prepare-metadata') {
    const [directory, sourceFile, version, sourceSha, metadataSourceSha, signedRunId, artifactId, tagSha, apkSha256, oldUpdateSha256, newUpdateSha256] = args;
    const recovery = policy.validateCandidateProvenance({ version, sourceSha, metadataSourceSha, signedRunId, artifactId, tagSha, apkSha256, oldUpdateSha256, newUpdateSha256 });
    const file = path.join(directory, 'update.json');
    assert.equal(hash(file), oldUpdateSha256, 'Signed metadata hash mismatch');
    const source = fs.readFileSync(sourceFile, 'utf8');
    if (recovery) {
      assert.equal(read(file).versionCode, 30319, 'V3.4.4 versionCode mismatch');
      assert.equal(read(file).changelog.includes('No hay APK V3.4.4 publicada.'), true, 'Historic defective metadata differs from documented source');
      fs.writeFileSync(file, policy.repairMetadata(read(file), source, version));
    }
    policy.validateMetadataSource(read(file), source, version);
    assert.equal(hash(file), newUpdateSha256, 'Final metadata hash mismatch');
    console.log(`Stable changelog source and final metadata verified${recovery ? ' after exact V3.4.4 recovery' : ''}`);
  } else if (mode === 'apk') {
    const [apkFile, updateFile, version, aaptFile] = args;
    const actual = apkInspection.inspectApk(apkFile, aaptFile);
    apkInspection.validateApkIdentity(actual, read(updateFile), version);
    console.log(`APK identity verified: ${actual.packageId} ${actual.versionName}/${actual.versionCode}, minSdk ${actual.minSdk}`);
  } else if (mode === 'certificate') {
    const [apkFile, apksignerFile] = args;
    const fingerprint = apkInspection.inspectSigningCertificate(apkFile, apksignerFile);
    apkInspection.validateSigningCertificate(fingerprint, policy.OFFICIAL_SIGNING_CERT_SHA256);
    console.log(`Official App Atletismo signing certificate verified: ${fingerprint}`);
  } else if (mode === 'stable') {
    const [latestFile, updateFile, candidateFile] = args;
    const latest = read(latestFile);
    const assets = latest.assets;
    assert.ok(Array.isArray(assets), 'Latest release assets unavailable');
    const metadataAssets = assets.filter((asset) => asset.name === 'update.json');
    assert.equal(metadataAssets.length, 1, 'Latest Stable update.json is ambiguous');
    const stableVersion = latest.tag_name.slice(1);
    const asset = metadataAssets[0];
    assert.equal(asset.browser_download_url, `https://github.com/${policy.RELEASES_REPO}/releases/download/v${stableVersion}/update.json`, 'Stable metadata URL mismatch');
    assert.equal(asset.size, fs.statSync(updateFile).size, 'Stable metadata size mismatch');
    assert.equal(asset.digest, `sha256:${hash(updateFile)}`, 'Stable metadata digest mismatch');
    const candidate = read(candidateFile);
    policy.validateStable(latest, read(updateFile), candidate);
    console.log(`Candidate ${candidate.version}/${candidate.versionCode} is strictly newer than and directly upgradeable from public Stable ${stableVersion}`);
  } else if (mode === 'release') {
    const [releaseFile, version, apkSha256, updateJsonSha256, draftText] = args;
    assert.ok(['true', 'false'].includes(draftText), 'Invalid draft expectation');
    policy.validateReleaseAssets(read(releaseFile), { version, apkSha256, updateJsonSha256, draft: draftText === 'true' });
    console.log(`Release v${version} assets and state verified`);
  } else {
    throw new Error(`Unknown publisher check: ${mode}`);
  }
} catch (error) {
  console.error(`Publisher validation failed: ${error.message}`);
  process.exitCode = 1;
}
