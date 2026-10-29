'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),R=require('../scripts/r1-release-verification');
test('R1 command verifies the exact three-file transport and rejects missing proof or identity',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'atletismo-public-r1-')),dir=path.join(root,'dist');fs.mkdirSync(dir);
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),source='a'.repeat(40),apk=Buffer.from('PUBLIC_SYNTHETIC_APK_DATA');
 const metadata={version:'3.5.0',versionCode:30322,metadataVersion:1,channel:'stable',minimumAppVersion:'3.4.5',changelog:'Public synthetic fixture',publishedAt:'2026-10-28T00:00:00Z',dataSchema:2,migrations:[],android:{packageId:'com.atletismo.personal',minSdk:24,abis:['universal'],size:apk.length,sha256:hash(apk),url:'https://github.com/calvoramiro757-sketch/Atletismo-Releases/releases/download/v3.5.0/Atletismo-release.apk'}};
 const json=Buffer.from(JSON.stringify(metadata)),logs=Object.fromEntries(['seed','verify','restore','mobile'].map(n=>['atletismo-'+n+'.log','OK (1 test)']));
 const proof={schema:1,sourceSHA:source,controllerSHA:source,runID:'41',certificateSHA256:R.CERTIFICATE,publicationAuthorized:false,version:'3.5.0',versionCode:30322,apkSHA256:hash(apk),metadataSHA256:hash(json),testSHA256:'e'.repeat(64),unsignedArtifactDigest:'sha256:'+'f'.repeat(64),upgrades:Object.fromEntries(Object.entries(R.BASELINES).map(([v,s])=>[v,{schema:1,status:'PASS',sourceSHA:source,runID:'41',baselineVersion:v,baselineSHA256:s,candidateSHA256:hash(apk),certificateSHA256:R.CERTIFICATE,preservedData:true,emulator:true,logs}]))};
 fs.writeFileSync(path.join(dir,'Atletismo-release.apk'),apk);fs.writeFileSync(path.join(dir,'update.json'),json);
 const receipt=path.join(dir,'release-verification.json');fs.writeFileSync(receipt,JSON.stringify(proof));
 const blob=path.join(root,'blob.txt');fs.writeFileSync(blob,R.R1_WORKFLOW_BLOB);
 const args=[path.resolve(__dirname,'../scripts/publisher-check.js'),'files',dir,'3.5.0',hash(apk),hash(json),blob],env={...process.env,SOURCE_SHA:source,SIGNED_RUN_ID:'41'};
 const run=()=>cp.spawnSync(process.execPath,args,{encoding:'utf8',env,timeout:30000});
 const good=run();assert.equal(good.status,0,good.stderr);
 const badIdentity=cp.spawnSync(process.execPath,args,{encoding:'utf8',env:{...env,SOURCE_SHA:'b'.repeat(40)},timeout:30000});assert.notEqual(badIdentity.status,0);
 proof.upgrades['3.4.5'].preservedData=false;fs.writeFileSync(receipt,JSON.stringify(proof));assert.notEqual(run().status,0);
 const legacy=cp.spawnSync(process.execPath,args.slice(0,-1),{encoding:'utf8',env,timeout:30000});assert.notEqual(legacy.status,0);
});
