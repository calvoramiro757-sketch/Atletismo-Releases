'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const R=require('../scripts/r1-release-verification'),P=require('../scripts/publisher-policy'),clone=v=>JSON.parse(JSON.stringify(v)),source='a'.repeat(40),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function evidence(){
 const run={id:41,workflow_id:359118454,path:'.github/workflows/build-release-apk.yml',head_sha:source,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',run_attempt:1,repository:{id:1372148180,full_name:'calvoramiro757-sketch/Atletismo'},head_repository:{full_name:'calvoramiro757-sketch/Atletismo'}};
 const jobs={total_count:5,jobs:Object.entries(R.REQUIRED_JOBS).map(([name,steps],i)=>({id:i+1,name,run_id:41,head_sha:source,status:'completed',conclusion:'success',started_at:'2026-10-28T00:00:00Z',completed_at:'2026-10-28T01:00:00Z',steps:steps.map(name=>({name,conclusion:'success'}))}))};
 const artifact={id:9,name:'Atletismo-release-artifact',expired:false,workflow_run:{id:41,head_sha:source,repository_id:1372148180},digest:'sha256:'+'d'.repeat(64),size_in_bytes:40,created_at:'2026-10-28T00:30:00Z'};
 return {run,jobs,artifact,workflowBlob:R.R1_WORKFLOW_BLOB,sourceSha:source,runId:41,artifactId:9};
}
const options={sourceSha:source,runId:41,version:'3.5.0',versionCode:30322,apkSha256:'b'.repeat(64),metadataSha256:'c'.repeat(64)};
function proof(){
 const logs=Object.fromEntries(['seed','verify','restore','mobile'].map(n=>['atletismo-'+n+'.log','OK (1 test)\n']));
 return {schema:1,sourceSHA:source,controllerSHA:source,runID:'41',certificateSHA256:R.CERTIFICATE,publicationAuthorized:false,version:'3.5.0',versionCode:30322,apkSHA256:options.apkSha256,metadataSHA256:options.metadataSha256,testSHA256:'e'.repeat(64),unsignedArtifactDigest:'sha256:'+'f'.repeat(64),upgrades:Object.fromEntries(Object.entries(R.BASELINES).map(([v,s])=>[v,{schema:1,status:'PASS',sourceSHA:source,runID:'41',baselineVersion:v,baselineSHA256:s,candidateSHA256:options.apkSha256,certificateSHA256:R.CERTIFICATE,preservedData:true,emulator:true,logs:clone(logs)}]))};
}
test('R1 requires all five roles and both upgrade baselines',()=>assert.equal(P.validateEvidence(evidence()).mode,'r1-isolated'));
const evidenceFaults={
 'different source':v=>v.run.head_sha='f'.repeat(40),
 'different branch':v=>v.run.head_branch='feature',
 'wrong event':v=>v.run.event='push',
 'failed workflow':v=>v.run.conclusion='failure',
 'missing upgrade':v=>v.jobs.jobs.pop(),
 'duplicate role':v=>v.jobs.jobs[3]=clone(v.jobs.jobs[2]),
 'failed critical step':v=>v.jobs.jobs[1].steps[0].conclusion='failure',
 'missing public gate check':v=>v.jobs.jobs[1].steps=v.jobs.jobs[1].steps.filter(s=>s.name!=='Verify protected public release gate'),
 'different artifact owner':v=>v.artifact.workflow_run.id=42,
 'expired artifact':v=>v.artifact.expired=true,
 'artifact from older attempt':v=>v.artifact.created_at='2026-10-27T00:00:00Z',
 'missing digest':v=>delete v.artifact.digest,
 'unreviewed workflow':v=>v.workflowBlob='0'.repeat(40)
};
for(const [name,change] of Object.entries(evidenceFaults))test('R1 rejects '+name,()=>{const v=evidence();change(v);assert.throws(()=>P.validateEvidence(v));});
test('release proof binds exact APK, metadata, original certificate and both upgrades',()=>assert.equal(R.validateProof(proof(),options),true));
const proofFaults={
 'wrong source':v=>v.sourceSHA='f'.repeat(40),
 'wrong controller':v=>v.controllerSHA='f'.repeat(40),
 'wrong run':v=>v.runID='42',
 'different certificate':v=>v.certificateSHA256='0'.repeat(64),
 'self authorization':v=>v.publicationAuthorized=true,
 'wrong metadata':v=>v.metadataSHA256='0'.repeat(64),
 'wrong version':v=>v.versionCode=30321,
 'missing baseline':v=>delete v.upgrades['3.4.5'],
 'different baseline bytes':v=>v.upgrades['3.4.5'].baselineSHA256='0'.repeat(64),
 'different installed APK':v=>v.upgrades['3.4.0'].candidateSHA256='0'.repeat(64),
 'no preservation':v=>v.upgrades['3.4.5'].preservedData=false,
 'no emulator':v=>v.upgrades['3.4.5'].emulator=false,
 'missing instrumentation':v=>delete v.upgrades['3.4.0'].logs['atletismo-restore.log'],
 'instrumentation failure':v=>v.upgrades['3.4.5'].logs['atletismo-mobile.log']='FAILURES\nOK (1 test)'
};
for(const [name,change] of Object.entries(proofFaults))test('proof rejects '+name,()=>{const v=proof();change(v);assert.throws(()=>R.validateProof(v,options));});
test('missing approved source identity is rejected',()=>assert.throws(()=>R.validateProof(proof(),{...options,sourceSha:undefined})));
