'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./publisher-policy');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const repo = policy.RELEASES_REPO;
const base = `https://api.github.com/repos/${repo}`;
const headers = () => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' });

async function request(method, url, body, accepted = [200]) {
  assert.ok(url.startsWith(`${base}/`) || url.startsWith(`https://uploads.github.com/repos/${repo}/releases/`), 'Unexpected GitHub API URL');
  const h = headers();
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
  if (!accepted.includes(response.status)) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}; reconcile before retry`);
  return response.status === 204 ? null : response.json();
}

async function readState(version) {
  const refUrl = `${base}/git/ref/tags/v${version}`;
  const response = await fetch(refUrl, { headers: headers(), redirect: 'error' });
  if (![200, 404].includes(response.status)) throw new Error(`Tag read HTTP ${response.status}`);
  const tag = response.status === 404 ? null : await response.json();
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const entries = await request('GET', `${base}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(entries), 'Release list unavailable');
    releases.push(...entries);
    if (entries.length < 100) break;
    assert.ok(page < 10, 'Release list exceeds audited pagination limit');
  }
  const latest = await request('GET', `${base}/releases/latest`);
  return { tag, releases, latest };
}

async function verifyAsset(asset, expectedSha, expectedSize) {
  assert.equal(asset.digest, `sha256:${expectedSha}`, 'Release asset digest differs from candidate');
  assert.equal(asset.size, expectedSize, 'Release asset size differs from candidate');
  const response = await fetch(`${base}/releases/assets/${asset.id}`, { headers: { ...headers(), Accept: 'application/octet-stream' } });
  assert.equal(response.status, 200, `Asset ${asset.id} download failed`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, expectedSize, `Downloaded asset ${asset.id} size differs`);
  assert.equal(hash(bytes), expectedSha, `Downloaded asset ${asset.id} hash differs`);
  console.log(`Verified release asset ${asset.name} id=${asset.id} sha256=${expectedSha}`);
}

async function verifyPresentAssets(release, expected, oldMetadata = false) {
  for (const asset of release.assets) {
    const apk = asset.name === 'Atletismo-release.apk';
    const sha = apk ? expected.apkSha256 : oldMetadata ? policy.V344_RECOVERY.oldUpdateSha256 : expected.updateJsonSha256;
    const size = apk ? expected.apkSize : oldMetadata ? policy.V344_RECOVERY.oldUpdateSize : expected.updateJsonSize;
    await verifyAsset(asset, sha, size);
  }
}

async function uploadAsset(release, name, bytes) {
  const prefix = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets`;
  assert.ok(release.upload_url === `${prefix}{?name,label}`, 'Unexpected upload URL');
  const response = await fetch(`${prefix}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    body: bytes,
    redirect: 'error'
  });
  if (response.status !== 201) throw new Error(`Asset upload HTTP ${response.status}; reconcile before retry`);
  const uploaded = await response.json();
  assert.equal(uploaded.name, name, 'Uploaded asset name mismatch');
  assert.equal(uploaded.digest, `sha256:${hash(bytes)}`, 'Uploaded asset digest mismatch');
  assert.equal(uploaded.size, bytes.length, 'Uploaded asset size mismatch');
  console.log(`Uploaded ${name} id=${uploaded.id} sha256=${hash(bytes)}`);
}

async function run(mode, directory) {
  assert.ok(['inspect', 'publish'].includes(mode), 'Invalid transaction mode');
  assert.ok(process.env.GH_TOKEN, 'Missing release token');
  const { VERSION: version, SOURCE_SHA: sourceSha, METADATA_SOURCE_SHA: metadataSourceSha,
    SIGNED_RUN_ID: signedRunId, ARTIFACT_ID: artifactId, APK_SHA256: apkSha256,
    ARTIFACT_UPDATE_SHA256: oldUpdateSha256, UPDATE_JSON_SHA256: newUpdateSha256,
    GITHUB_SHA: publisherSha } = process.env;
  const recovery = policy.validateCandidateProvenance({ version, sourceSha, metadataSourceSha, signedRunId, artifactId,
    tagSha: policy.V344_RECOVERY.tagSha, apkSha256, oldUpdateSha256, newUpdateSha256 });
  assert.match(publisherSha, /^[a-f0-9]{40}$/, 'Invalid publisher SHA');
  if (mode === 'publish') assert.equal(process.env.PUBLISH_CONFIRM, 'true', 'Publication requires explicit confirmation');
  const apk = fs.readFileSync(path.join(directory, 'Atletismo-release.apk'));
  const update = fs.readFileSync(path.join(directory, 'update.json'));
  assert.equal(hash(apk), apkSha256, 'Local APK hash differs');
  assert.equal(hash(update), newUpdateSha256, 'Local metadata hash differs');
  const metadata = JSON.parse(update.toString('utf8'));
  policy.validateMetadata(metadata, { version, apkSha256, apkSize: apk.length });
  if (recovery) assert.equal(metadata.versionCode, 30319, 'V3.4.4 versionCode mismatch');
  const notes = policy.releaseNotes({ sourceSha, metadataSourceSha: recovery ? metadataSourceSha : undefined,
    signedRunId, artifactId, apkSha256, updateJsonSha256: newUpdateSha256, publisherSha,
    replacedUpdateSha256: recovery ? oldUpdateSha256 : undefined });
  const expected = { version, tagSha: recovery ? policy.V344_RECOVERY.tagSha : publisherSha,
    apkSha256, updateJsonSha256: newUpdateSha256, apkSize: apk.length, updateJsonSize: update.length,
    notes, recovery };

  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await readState(version);
    if (state.latest.tag_name !== `v${version}`) {
      assert.ok(policy.compareVersions(version, state.latest.tag_name.slice(1)) > 0, 'A newer Stable is already public');
    }
    const decision = policy.reconcileReleaseState({ ...state, expected });
    console.log(`Reconciled v${version}: ${decision.action}${decision.releaseId ? ` release=${decision.releaseId}` : ''}`);
    if (decision.action === 'complete') {
      const release = state.releases.find((item) => item.id === decision.releaseId);
      await verifyPresentAssets(release, expected);
      return;
    }
    if (mode === 'inspect') {
      if (decision.releaseId) {
        const release = state.releases.find((item) => item.id === decision.releaseId);
        await verifyPresentAssets(release, expected, decision.action === 'repair-metadata');
      }
      return;
    }
    if (decision.action === 'create-tag') {
      await request('POST', `${base}/git/refs`, { ref: `refs/tags/v${version}`, sha: expected.tagSha }, [201]);
    } else if (decision.action === 'create-draft') {
      await request('POST', `${base}/releases`, { tag_name: `v${version}`, target_commitish: expected.tagSha,
        name: `App Atletismo V${version}`, body: notes, draft: true, prerelease: false }, [201]);
    } else {
      const release = state.releases.find((item) => item.id === decision.releaseId);
      await verifyPresentAssets(release, expected, decision.action === 'repair-metadata');
      if (decision.action === 'repair-metadata') {
        assert.ok(recovery, 'Metadata repair is restricted to V3.4.4');
        console.log(`Preserving failed attempt: old update.json asset=${decision.oldAssetId} sha256=${oldUpdateSha256}`);
        await request('DELETE', `${base}/releases/assets/${decision.oldAssetId}`, undefined, [204]);
      } else if (decision.action === 'upload-assets') {
        for (const name of decision.missing) await uploadAsset(release, name, name === 'Atletismo-release.apk' ? apk : update);
      } else if (decision.action === 'update-notes') {
        await request('PATCH', `${base}/releases/${decision.releaseId}`, { body: notes }, [200]);
      } else if (decision.action === 'promote') {
        await request('PATCH', `${base}/releases/${decision.releaseId}`, { draft: false, make_latest: 'true' }, [200]);
      } else {
        throw new Error(`Unsupported reconciliation action: ${decision.action}`);
      }
    }
  }
  throw new Error('Release did not converge after twelve state changes; reconcile before retry');
}

if (require.main === module) run(process.argv[2], process.argv[3]).catch((error) => {
  console.error(`Publisher transaction stopped: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { run, readState, verifyAsset };
