'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const policy = require('../scripts/publisher-policy');

const version = '3.4.5';
const tagSha = 'a'.repeat(40);
const apkHash = 'b'.repeat(64);
const updateHash = 'c'.repeat(64);
const notes = policy.releaseNotes({ sourceSha: 'd'.repeat(40), signedRunId: 12, artifactId: 34, apkSha256: apkHash, updateJsonSha256: updateHash, publisherSha: tagSha });
const expected = { version, tagSha, apkSha256: apkHash, updateJsonSha256: updateHash, apkSize: 100, updateJsonSize: 50, notes };
const url = (name, slug = `v${version}`) => `https://github.com/${policy.RELEASES_REPO}/releases/download/${slug}/${name}`;
const tag = () => ({ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: tagSha } });
const asset = (name, id, digest, size) => ({ id, name, digest: `sha256:${digest}`, size, state: 'uploaded', browser_download_url: url(name) });
const draft = () => ({ id: 123, tag_name: `v${version}`, name: `App Atletismo V${version}`, body: notes, draft: true, prerelease: false, target_commitish: tagSha, html_url: `https://github.com/${policy.RELEASES_REPO}/releases/tag/untagged-123abc`, assets: [asset('Atletismo-release.apk', 1, apkHash, 100), asset('update.json', 2, updateHash, 50)] });
const latest = () => ({ id: 99, tag_name: 'v3.4.4', draft: false, prerelease: false });
const plan = (overrides = {}) => policy.reconcileReleaseState({ tag: tag(), releases: [draft()], latest: latest(), expected, ...overrides });

test('new publication resumes from no tag, correct tag, partial draft, full draft and public release', () => {
  assert.equal(plan({ tag: null, releases: [] }).action, 'create-tag');
  assert.equal(plan({ releases: [] }).action, 'create-draft');
  const partial = draft(); partial.assets.pop();
  assert.deepEqual(plan({ releases: [partial] }), { action: 'upload-assets', releaseId: 123, missing: ['update.json'] });
  assert.equal(plan().action, 'promote');
  const publicRelease = { ...draft(), draft: false, html_url: `https://github.com/${policy.RELEASES_REPO}/releases/tag/v${version}` };
  assert.equal(plan({ releases: [publicRelease], latest: publicRelease }).action, 'complete');
});

test('wrong tag, duplicate release, incompatible notes, assets and older publisher fail closed', () => {
  assert.throws(() => plan({ tag: { ...tag(), object: { type: 'commit', sha: '0'.repeat(40) } } }), /unexpected commit/);
  assert.throws(() => plan({ releases: [draft(), draft()] }), /Duplicate releases/);
  assert.throws(() => plan({ releases: [{ ...draft(), body: 'different' }] }), /provenance notes/);
  assert.throws(() => plan({ releases: [{ ...draft(), assets: [asset('Atletismo-release.apk', 1, '0'.repeat(64), 100)] }] }), /digest/);
  assert.throws(() => plan({ releases: [{ ...draft(), assets: [...draft().assets, asset('extra', 3, updateHash, 50)] }] }), /Unexpected or duplicate/);
  assert.throws(() => plan({ releases: [{ ...draft(), draft: false }], latest: latest() }), /older publication/);
  assert.throws(() => plan({ tag: null, releases: [draft()] }), /without expected tag/);
});

test('V3.4.4 historic draft permits only exact metadata replacement, then resumes', () => {
  const r = policy.V344_RECOVERY;
  const repairedNotes = policy.releaseNotes({ sourceSha: r.sourceSha, metadataSourceSha: r.metadataSourceSha, signedRunId: r.signedRunId, artifactId: r.artifactId, apkSha256: r.apkSha256, updateJsonSha256: r.newUpdateSha256, replacedUpdateSha256: r.oldUpdateSha256 });
  const oldNotes = policy.releaseNotes({ sourceSha: r.sourceSha, signedRunId: r.signedRunId, artifactId: r.artifactId, apkSha256: r.apkSha256, updateJsonSha256: r.oldUpdateSha256 });
  const slug = 'untagged-5c8d6e31885078dea5c5';
  const old = {
    id: r.releaseId, tag_name: 'v3.4.4', name: 'App Atletismo V3.4.4', body: oldNotes, draft: true,
    prerelease: false, target_commitish: 'main', html_url: `https://github.com/${policy.RELEASES_REPO}/releases/tag/${slug}`,
    assets: [
      { ...asset('Atletismo-release.apk', r.apkAssetId, r.apkSha256, 45873398), browser_download_url: url('Atletismo-release.apk', slug) },
      { ...asset('update.json', r.oldUpdateAssetId, r.oldUpdateSha256, r.oldUpdateSize), browser_download_url: url('update.json', slug) }
    ]
  };
  const e = { version: r.version, tagSha: r.tagSha, apkSha256: r.apkSha256, updateJsonSha256: r.newUpdateSha256, apkSize: 45873398, updateJsonSize: 1757, notes: repairedNotes, recovery: true };
  const state = (release) => policy.reconcileReleaseState({ tag: { ref: 'refs/tags/v3.4.4', object: { type: 'commit', sha: r.tagSha } }, releases: [release], latest: latest(), expected: e });
  assert.deepEqual(state(old), { action: 'repair-metadata', releaseId: r.releaseId, oldAssetId: r.oldUpdateAssetId, missing: [] });
  assert.equal(state({ ...old, assets: [old.assets[0]] }).action, 'upload-assets');
  const newAsset = { ...old.assets[1], id: 3, digest: `sha256:${r.newUpdateSha256}`, size: 1757 };
  assert.equal(state({ ...old, assets: [old.assets[0], newAsset] }).action, 'update-notes');
  assert.equal(state({ ...old, body: repairedNotes, assets: [old.assets[0], newAsset] }).action, 'promote');
  assert.throws(() => state({ ...old, assets: [{ ...old.assets[0], digest: 'sha256:' + '0'.repeat(64) }, old.assets[1]] }), /digest/);
  assert.throws(() => state({ ...old, assets: [old.assets[0], { ...old.assets[1], id: 4 }] }), /digest/);
  assert.throws(() => policy.reconcileReleaseState({ tag: null, releases: [], latest: latest(), expected: e }), /recovery draft is missing/);
});

test('the one historic draft remains identifiable after GitHub changes its tag_name to its untagged slug', () => {
  const r = policy.V344_RECOVERY;
  const publisherSha = 'f'.repeat(40);
  const beforeNotes = policy.releaseNotes({ sourceSha: r.sourceSha, metadataSourceSha: r.metadataSourceSha,
    signedRunId: r.signedRunId, artifactId: r.artifactId, apkSha256: r.apkSha256,
    updateJsonSha256: r.newUpdateSha256, publisherSha: r.firstRepairPublisherSha,
    replacedUpdateSha256: r.oldUpdateSha256 });
  const afterNotes = policy.releaseNotes({ sourceSha: r.sourceSha, metadataSourceSha: r.metadataSourceSha,
    signedRunId: r.signedRunId, artifactId: r.artifactId, apkSha256: r.apkSha256,
    updateJsonSha256: r.newUpdateSha256, publisherSha, resumedFromPublisherSha: r.firstRepairPublisherSha,
    replacedUpdateSha256: r.oldUpdateSha256 });
  const baseUrl = `https://github.com/${policy.RELEASES_REPO}`;
  const partial = {
    id: r.releaseId, tag_name: r.draftSlug, name: 'App Atletismo V3.4.4',
    body: beforeNotes, draft: true, prerelease: false, target_commitish: 'main',
    html_url: `${baseUrl}/releases/tag/${r.draftSlug}`,
    assets: [
      { id: r.apkAssetId, name: 'Atletismo-release.apk', size: 45873398, state: 'uploaded',
        digest: `sha256:${r.apkSha256}`, browser_download_url: `${baseUrl}/releases/download/${r.draftSlug}/Atletismo-release.apk` },
      { id: 593095487, name: 'update.json', size: 1757, state: 'uploaded',
        digest: `sha256:${r.newUpdateSha256}`, browser_download_url: `${baseUrl}/releases/download/${r.draftSlug}/update.json` }
    ]
  };
  const expected = { version: r.version, tagSha: r.tagSha, apkSha256: r.apkSha256,
    updateJsonSha256: r.newUpdateSha256, apkSize: 45873398, updateJsonSize: 1757,
    notes: afterNotes, recovery: true };
  const tag = { ref: 'refs/tags/v3.4.4', object: { type: 'commit', sha: r.tagSha } };
  const state = (releases, overrides = {}) => policy.reconcileReleaseState({ tag, releases, latest: latest(), expected, ...overrides });
  assert.equal(state([partial]).action, 'update-notes');
  assert.equal(state([{ ...partial, body: afterNotes }]).action, 'restore-tag');
  assert.equal(state([{ ...partial, tag_name: 'v3.4.4', body: afterNotes }]).action, 'promote');
  assert.throws(() => state([partial, { ...partial, id: 999 }]), /Duplicate release title/);
  assert.throws(() => state([partial, { ...partial, id: 999, tag_name: 'v3.4.4', name: 'Different' }]), /Duplicate releases for version/);
  assert.throws(() => state([{ ...partial, id: 999 }]), /recovery draft is missing/);
  assert.throws(() => state([{ ...partial, tag_name: 'untagged-other' }]), /Unexpected recovery release tag_name/);
  assert.throws(() => state([partial], { tag: { ...tag, object: { type: 'commit', sha: '0'.repeat(40) } } }), /unexpected commit/);
});

test('metadata source must be stable-ready, versioned and identical to candidate', () => {
  const source = '---\nreleaseStatus: stable-ready\nversion: 3.4.4\n---\n# V3.4.4 — Perfil Velocista\nFinal.\n';
  const candidate = { version: '3.4.4', changelog: '# V3.4.4 — Perfil Velocista\nFinal.\n' };
  assert.doesNotThrow(() => policy.validateMetadataSource(candidate, source, '3.4.4'));
  assert.throws(() => policy.validateMetadataSource(candidate, source.replace('stable-ready', 'development'), '3.4.4'), /Development changelog/);
  assert.throws(() => policy.validateMetadataSource(candidate, source.replace('3.4.4', '3.4.3'), '3.4.4'), /version mismatch/);
  assert.throws(() => policy.validateMetadataSource({ ...candidate, changelog: 'Development' }, source, '3.4.4'), /differs/);
});

test('technically valid signed metadata with development changelog fails before publication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-development-'));
  try {
    const source = path.join(directory, 'changelog.md');
    const metadata = path.join(directory, 'update.json');
    const changelog = '# V3.4.5 — Perfil Velocista\nWork still in development.\n';
    fs.writeFileSync(source, `---\nreleaseStatus: development\nversion: 3.4.5\n---\n${changelog}`);
    fs.writeFileSync(metadata, JSON.stringify({ version: '3.4.5', changelog }) + '\n');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(metadata)).digest('hex');
    const check = spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'),
      'prepare-metadata', directory, source, '3.4.5', 'a'.repeat(40), 'a'.repeat(40),
      '12', '34', 'b'.repeat(40), 'c'.repeat(64), digest, digest], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /Development changelog cannot be published as Stable/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(metadata)).digest('hex'), digest);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'publisher-development-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('only the exact V3.4.4 candidate can use a metadata source after the signed build', () => {
  const r = policy.V344_RECOVERY;
  assert.equal(policy.validateCandidateProvenance({ ...r, oldUpdateSha256: r.oldUpdateSha256, newUpdateSha256: r.newUpdateSha256 }), true);
  assert.throws(() => policy.validateCandidateProvenance({ ...r, oldUpdateSha256: '0'.repeat(64) }), /recovery oldUpdateSha256 mismatch/);
  assert.throws(() => policy.validateCandidateProvenance({ ...r, tagSha: 'de6266cbf54ad04ce8f88d261179d9599a02c4f8' }), /recovery tagSha mismatch/);
  assert.throws(() => policy.validateCandidateProvenance({ ...r, version: '3.4.5' }), /Future metadata source/);
});

test('dry run reads the real V3.4.4 tag instead of passing the publisher commit as tag SHA', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-recovery-tag-'));
  try {
    const file = path.join(directory, 'tag.json');
    const check = () => spawnSync(process.execPath, [path.join(__dirname, '../scripts/publisher-check.js'), 'recovery-tag', file], { encoding: 'utf8' });
    fs.writeFileSync(file, JSON.stringify({ ref: 'refs/tags/v3.4.4', object: { type: 'commit', sha: policy.V344_RECOVERY.tagSha } }));
    assert.equal(check().status, 0);
    fs.writeFileSync(file, JSON.stringify({ ref: 'refs/tags/v3.4.4', object: { type: 'commit', sha: 'de6266cbf54ad04ce8f88d261179d9599a02c4f8' } }));
    const wrong = check();
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /recovery tag SHA mismatch/);
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-atletismo-release.yml'), 'utf8');
    assert.match(workflow, /node scripts\/publisher-check\.js recovery-tag "\$RUNNER_TEMP\/recovery-tag\.json"/);
    assert.match(workflow, /candidate_tag_sha=\$\(jq -er '\.object\.sha' "\$RUNNER_TEMP\/recovery-tag\.json"\)/);
    assert.match(workflow, /prepare-metadata dist .* "\$candidate_tag_sha"/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'publisher-recovery-tag-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
