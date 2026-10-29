'use strict';
const assert=require('node:assert/strict');
const R1_WORKFLOW_BLOB='52aaf6940d8f717070b143209c42624b8abb64c9';
const REQUIRED_JOBS={"Unprivileged build":["Require trusted controller and reviewed SHA","Checkout trusted controller","Checkout candidate without signing secrets","Set up Java 21","Build and test without original key","Upload unsigned data"],"Isolated signing":["Checkout trusted signing controller","Set up Java 21","Verify trusted ref and fixed tools","Fetch exact unsigned artifact and preflight before key access","Verify protected public release gate","Sign data with original key","Upload signed data without key"],"Upgrade 3.4.0":["Checkout trusted upgrade controller","Set up Java 21","Get exact signed candidate and published baseline","Enable emulator acceleration","Verify upgrade in a disposable emulator","Bind preservation proof to exact APK","Upload baseline proof"],"Upgrade 3.4.5":["Checkout trusted upgrade controller","Set up Java 21","Get exact signed candidate and published baseline","Enable emulator acceleration","Verify upgrade in a disposable emulator","Bind preservation proof to exact APK","Upload baseline proof"],"Release evidence":["Checkout trusted collector","Bind both upgrades and signed metadata","Upload release only after both upgrades pass"]};
const CERTIFICATE='9dfe429d7de62570120a3d9f8f0026e55317f57bae4f9d8acbcab32941191ce5';
const BASELINES={'3.4.0':'9245adeb7eaee96380ab869d4456bf119cbfde408cb90f9172f2438368884ace','3.4.5':'af9f4e73a0414e82052bb0601e8fd0b07f180866583008e23bc52768a966629c'};
const FILES=Object.freeze(['Atletismo-release.apk','update.json','release-verification.json']);
function validateEvidence({run,jobs,artifact,workflowBlob,sourceSha,runId,artifactId}){
 assert.equal(workflowBlob,R1_WORKFLOW_BLOB,'Unreviewed R1 workflow');
 assert.match(sourceSha,/^[a-f0-9]{40}$/);
 assert.equal(String(run.id),String(runId));
 assert.equal(run.workflow_id,359118454,'Wrong signed workflow');
 assert.equal(run.path,'.github/workflows/build-release-apk.yml');
 assert.equal(run.head_sha,sourceSha,'Controller must be the reviewed source');
 assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');
 assert.equal(run.repository?.full_name,'calvoramiro757-sketch/Atletismo');
 assert.equal(run.head_repository?.full_name,'calvoramiro757-sketch/Atletismo');
 assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
 assert.ok(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0);
 assert.equal(jobs.total_count,5);assert.equal(jobs.jobs.length,5);
 assert.equal(new Set(jobs.jobs.map(j=>j.id)).size,5);
 for(const [name,steps] of Object.entries(REQUIRED_JOBS)){
  const found=jobs.jobs.filter(j=>j.name===name);assert.equal(found.length,1,'R1 missing/duplicate job '+name);
  const j=found[0];assert.ok(Number.isSafeInteger(j.id)&&j.id>0);
  assert.equal(j.run_id,run.id);assert.equal(j.head_sha,sourceSha);
  assert.equal(j.status,'completed');assert.equal(j.conclusion,'success');
  for(const name of steps){const found=j.steps.filter(s=>s.name===name);assert.equal(found.length,1,'Missing/duplicate R1 step '+name);assert.equal(found[0].conclusion,'success');}
 }
 assert.equal(String(artifact.id),String(artifactId));
 assert.equal(artifact.name,'Atletismo-release-artifact');assert.equal(artifact.expired,false);
 assert.equal(artifact.workflow_run?.id,run.id);assert.equal(artifact.workflow_run?.head_sha,sourceSha);
 assert.equal(artifact.workflow_run?.repository_id,run.repository.id);
 assert.match(artifact.digest,/^sha256:[a-f0-9]{64}$/);
 assert.ok(Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=256*1024*1024);
 const j=jobs.jobs.find(j=>j.name==='Release evidence'),created=Date.parse(artifact.created_at),start=Date.parse(j.started_at),end=Date.parse(j.completed_at);
 assert.ok(Number.isFinite(created)&&Number.isFinite(start)&&Number.isFinite(end)&&created>=start&&created<=end,'Artifact from different attempt');
 return {attempt:run.run_attempt,artifactDigest:artifact.digest,mode:'r1-isolated'};
}
function validateProof(p,{sourceSha,runId,version,versionCode,apkSha256,metadataSha256}){
 assert.match(sourceSha,/^[a-f0-9]{40}$/);assert.match(String(runId),/^[1-9][0-9]*$/);assert.equal(p.schema,1);assert.equal(p.sourceSHA,sourceSha);assert.equal(p.controllerSHA,sourceSha);
 assert.equal(p.runID,String(runId));assert.equal(p.certificateSHA256,CERTIFICATE);
 assert.equal(p.publicationAuthorized,false,'Receipt cannot authorize publication');
 assert.equal(p.version,version);assert.equal(p.versionCode,versionCode);assert.ok(versionCode>30321);
 assert.equal(p.apkSHA256,apkSha256);assert.equal(p.metadataSHA256,metadataSha256);
 assert.match(p.testSHA256,/^[a-f0-9]{64}$/);assert.match(p.unsignedArtifactDigest,/^sha256:[a-f0-9]{64}$/);
 assert.deepEqual(Object.keys(p.upgrades).sort(),Object.keys(BASELINES).sort(),'Both upgrade proofs required');
 for(const [version,sha] of Object.entries(BASELINES)){
  const u=p.upgrades[version];assert.equal(u.schema,1);assert.equal(u.status,'PASS');
  assert.equal(u.sourceSHA,sourceSha);assert.equal(u.runID,String(runId));
  assert.equal(u.baselineVersion,version);assert.equal(u.baselineSHA256,sha);
  assert.equal(u.candidateSHA256,apkSha256);assert.equal(u.certificateSHA256,CERTIFICATE);
  assert.equal(u.preservedData,true);assert.equal(u.emulator,true);
  for(const name of ['atletismo-seed.log','atletismo-verify.log','atletismo-restore.log','atletismo-mobile.log']){
   const text=u.logs[name];assert.ok(typeof text==='string'&&Buffer.byteLength(text)<=128*1024);
   assert.ok(text.includes('OK (1 test)')&&!text.includes('FAILURES')&&!text.includes('INSTRUMENTATION_FAILED'),'Incomplete instrumentation '+name);
  }
 }
 return true;
}
module.exports={R1_WORKFLOW_BLOB,REQUIRED_JOBS,CERTIFICATE,BASELINES,FILES,validateEvidence,validateProof};
