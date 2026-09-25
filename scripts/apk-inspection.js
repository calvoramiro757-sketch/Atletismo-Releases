'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function parseApkBadging(output) {
  assert.equal(typeof output, 'string', 'aapt badging output unavailable');
  const packageLines = output.match(/^package: .*$/gm) || [];
  const sdkLines = output.match(/^sdkVersion:.*$/gm) || [];
  assert.equal(packageLines.length, 1, 'APK must have exactly one package identity');
  assert.equal(sdkLines.length, 1, 'APK must have exactly one minimum SDK');
  const identity = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'(?: |$)/.exec(packageLines[0].trimEnd());
  const sdk = /^sdkVersion:'([0-9]+)'$/.exec(sdkLines[0].trimEnd());
  assert.ok(identity, 'APK package/version fields cannot be parsed');
  assert.ok(sdk, 'APK minSdk cannot be parsed');
  const versionCode = Number(identity[2]);
  const minSdk = Number(sdk[1]);
  assert.ok(Number.isSafeInteger(versionCode) && versionCode > 0, 'Invalid APK versionCode');
  assert.ok(Number.isSafeInteger(minSdk) && minSdk > 0, 'Invalid APK minSdk');
  return { packageId: identity[1], versionCode, versionName: identity[3], minSdk };
}

function validateApkIdentity(actual, metadata, expectedVersion) {
  assert.ok(metadata && metadata.android, 'Missing update.json android metadata');
  assert.equal(actual.packageId, 'com.atletismo.personal', 'APK packageId is not App Atletismo');
  assert.equal(actual.packageId, metadata.android.packageId, 'APK/metadata packageId mismatch');
  assert.equal(actual.versionName, expectedVersion, 'APK/input versionName mismatch');
  assert.equal(actual.versionName, metadata.version, 'APK/metadata versionName mismatch');
  assert.equal(actual.versionCode, metadata.versionCode, 'APK/metadata versionCode mismatch');
  assert.equal(actual.minSdk, metadata.android.minSdk, 'APK/metadata minSdk mismatch');
}

function inspectApk(apkFile, aaptFile) {
  const result = spawnSync(aaptFile, ['dump', 'badging', apkFile], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  assert.ok(!result.error, `aapt could not inspect APK: ${result.error?.message}`);
  assert.equal(result.status, 0, `Invalid APK or aapt failed: ${result.stderr || result.stdout}`);
  return parseApkBadging(result.stdout);
}

module.exports = { parseApkBadging, validateApkIdentity, inspectApk };
