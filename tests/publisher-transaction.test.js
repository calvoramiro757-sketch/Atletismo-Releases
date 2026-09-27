'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const policy = require('../scripts/publisher-policy');
const transaction = require('../scripts/publisher-transaction');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('publisher resumes a partial draft and a completed publication without duplicate assets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-transaction-'));
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const version = '3.4.5';
  const sourceSha = 'a'.repeat(40);
  const publisherSha = 'b'.repeat(40);
  const apk = Buffer.from('synthetic APK bytes, never published');
  const apkSha256 = sha(apk);
  const metadata = {
    metadataVersion: 2, version, versionCode: 30320, channel: 'stable',
    publishedAt: '2026-09-27T00:00:00.000Z', minimumAppVersion: '3.4.4',
    dataSchema: 2, migrations: [], changelog: '# V3.4.5 — Stable\nFinal.\n',
    android: { packageId: policy.PACKAGE_ID, minSdk: 24, abis: ['universal'], size: apk.length,
      sha256: apkSha256, url: `https://github.com/${policy.RELEASES_REPO}/releases/download/v${version}/Atletismo-release.apk` }
  };
  const update = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  const updateSha256 = sha(update);
  fs.writeFileSync(path.join(directory, 'Atletismo-release.apk'), apk);
  fs.writeFileSync(path.join(directory, 'update.json'), update);
  Object.assign(process.env, { GH_TOKEN: 'synthetic-test-token', VERSION: version, SOURCE_SHA: sourceSha,
    METADATA_SOURCE_SHA: sourceSha, SIGNED_RUN_ID: '12', ARTIFACT_ID: '34', APK_SHA256: apkSha256,
    ARTIFACT_UPDATE_SHA256: updateSha256, UPDATE_JSON_SHA256: updateSha256,
    GITHUB_SHA: publisherSha, PUBLISH_CONFIRM: 'true' });
  let tag = null;
  let release = null;
  const bytesById = new Map();
  const writes = [];
  let failOneUpload = true;
  const base = `https://api.github.com/repos/${policy.RELEASES_REPO}`;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      if (url === `${base}/git/ref/tags/v${version}`) return tag ? json(tag) : json({ message: 'Not Found' }, 404);
      if (url.startsWith(`${base}/releases?per_page=100`)) return json(release ? [release] : []);
      if (url === `${base}/releases/latest`) return json(release && !release.draft ? release : { id: 99, tag_name: 'v3.4.4', draft: false, prerelease: false });
      if (url === `${base}/git/refs` && method === 'POST') {
        assert.equal(tag, null);
        const body = JSON.parse(options.body);
        tag = { ref: body.ref, object: { type: 'commit', sha: body.sha } };
        writes.push('tag');
        return json(tag, 201);
      }
      if (url === `${base}/releases` && method === 'POST') {
        assert.equal(release, null);
        const body = JSON.parse(options.body);
        release = { ...body, id: 123, html_url: `https://github.com/${policy.RELEASES_REPO}/releases/tag/untagged-123abc`,
          upload_url: `https://uploads.github.com/repos/${policy.RELEASES_REPO}/releases/123/assets{?name,label}`, assets: [] };
        writes.push('draft');
        return json(release, 201);
      }
      if (url.startsWith(`https://uploads.github.com/repos/${policy.RELEASES_REPO}/releases/123/assets?name=`) && method === 'POST') {
        const name = decodeURIComponent(new URL(url).searchParams.get('name'));
        if (name === 'update.json' && failOneUpload) {
          failOneUpload = false;
          return json({ message: 'temporary failure' }, 500);
        }
        const bytes = Buffer.from(options.body);
        const id = 200 + release.assets.length;
        const asset = { id, name, size: bytes.length, digest: `sha256:${sha(bytes)}`, state: 'uploaded',
          browser_download_url: `https://github.com/${policy.RELEASES_REPO}/releases/download/v${version}/${name}` };
        bytesById.set(id, bytes);
        release.assets.push(asset);
        writes.push(`upload:${name}`);
        return json(asset, 201);
      }
      const assetMatch = new RegExp(`^${base}/releases/assets/(\\d+)$`).exec(url);
      if (assetMatch) return new Response(bytesById.get(Number(assetMatch[1])));
      if (url === `${base}/releases/123` && method === 'PATCH') {
        const body = JSON.parse(options.body);
        Object.assign(release, body);
        if (body.draft === false) release.html_url = `https://github.com/${policy.RELEASES_REPO}/releases/tag/v${version}`;
        writes.push(body.draft === false ? 'promote' : 'notes');
        return json(release);
      }
      throw new Error(`Unexpected mock request: ${method} ${url}`);
    };
    await assert.rejects(transaction.run('publish', directory), /Asset upload HTTP 500; reconcile before retry/);
    assert.deepEqual(writes, ['tag', 'draft', 'upload:Atletismo-release.apk']);
    await transaction.run('publish', directory);
    assert.deepEqual(writes, ['tag', 'draft', 'upload:Atletismo-release.apk', 'upload:update.json', 'promote']);
    assert.equal(release.draft, false);
    await transaction.run('publish', directory);
    assert.equal(writes.length, 5, 'Completed release must not be written again');
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ['GH_TOKEN', 'VERSION', 'SOURCE_SHA', 'METADATA_SOURCE_SHA', 'SIGNED_RUN_ID', 'ARTIFACT_ID', 'APK_SHA256', 'ARTIFACT_UPDATE_SHA256', 'UPDATE_JSON_SHA256', 'GITHUB_SHA', 'PUBLISH_CONFIRM']) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
    }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'publisher-transaction-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
