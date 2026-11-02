import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS as BASE_DEFAULTS, validateConfig, defaultDataDir } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { runDaily, runWithRetries, inspect } from '../src/runner.mjs';
import { BusinessError } from '../src/adapters/uestc.mjs';
import { CheckinAuthorizationError } from '../src/checkin-ticket.mjs';
import { checkinWindow, findDorm } from '../src/policy.mjs';
import { dueReport, tick as tickActual } from '../src/daemon.mjs';
const tick=options=>tickActual({...options,notify:async()=>{}});
// Extended cutoff is deliberate here, to exercise the generic scheduler's recovery bounds.
const DEFAULTS={...BASE_DEFAULTS,submissionsEnabled:true,recoveryCutoff:'23:55'};
const DATE='2026-10-10',NOW=new Date(DATE+'T22:30:00+08:00');
const ok=data=>({code:0,ok:true,data});
const pending=()=>ok({businessDate:DATE,recordStatusCode:'PENDING'});
const saved=()=>ok({businessDate:DATE,recordStatusCode:'CHECKED_IN'});
const schedule=()=>ok({studentCheckinStartOffsetMinute:1320,studentCheckinEndOffsetMinute:1410});
const geo={latitude:10,longitude:10,accuracy:20};
function setup(t,overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),calls=[],ctx={close:async()=>calls.push('close')};
  let record=pending();
  const adapter={
    authenticate:async()=>calls.push('auth'),getToday:async()=>{calls.push('today');return record;},
    prepareCheckinAuthorization:async()=>({result:'authorization_available',serverVerified:false}),
    getSchedule:async()=>schedule(),getLocation:async()=>geo,getAddress:async()=>'',getUserAgent:async()=>'synthetic-test-agent',
    getCheckinLocations:async()=>ok([{...geo,radiusMeter:100}]),
    submitCheckin:async body=>{calls.push(['checkin',body]);record=saved();return ok(null);},
    ...overrides,
  };
  const options={config:DEFAULTS,store,now:()=>NOW,open:async()=>ctx,adapterFactory:()=>adapter,sleep:async()=>{}};
  return {options,store,calls,adapter,setRecord:r=>{record=r;}};
}
const posts=calls=>calls.filter(x=>Array.isArray(x));

test('check-in configuration has no reporting fields and starts disabled',()=>{
  const config=validateConfig({});
  assert.equal(config.submissionsEnabled,false);
  assert.equal(config.recoveryCutoff,'23:30');
  for(const key of ['remark','keyword','locationType']) {
    assert.equal(Object.hasOwn(config,key),false);
    assert.throws(()=>validateConfig({[key]:'obsolete'}));
  }
  assert.throws(()=>validateConfig({reportTime:'24:00'}));
  assert.throws(()=>validateConfig({sessionIntervalMinutes:0}));
  assert.throws(()=>validateConfig({typo:true}));
});
test('state paths remain independent of checkout',()=>{
  assert.equal(defaultDataDir({platform:'linux',home:'/home/test',env:{}}),'/home/test/.local/state/goodnight');
  assert.equal(defaultDataDir({platform:'win32',home:'C:\\Users\\test',env:{}}),'C:\\Users\\test\\AppData\\Local\\GoodNight');
});
test('valid dormitory location submits and verifies only a check-in',async t=>{
  const f=setup(t);const out=await runDaily(f.options);
  assert.equal(out.result,'success');assert.equal(out.operation,'checkin');
  assert.equal(posts(f.calls).length,1);
  const [kind,body]=posts(f.calls)[0];assert.equal(kind,'checkin');
  assert.equal(body.latitude,geo.latitude);assert.equal(body.clientTime,DATE+' 22:30:00');
  for(const key of ['caseRemark','caseKeyword','reportedLocationTypeCode'])assert.equal(Object.hasOwn(body,key),false);
});
test('outside all available dormitory circles stops without any submission',async t=>{
  const f=setup(t,{getCheckinLocations:async()=>ok([])});
  const out=await runDaily(f.options);
  assert.equal(out.result,'location_fail');assert.equal(out.reason,'outside_dormitory_range');
  assert.equal(posts(f.calls).length,0);
});
test('explicit rejection stays a rejection with no fallback or repeated POST',async t=>{
  const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);return {code:4001,ok:false};}});
  assert.equal((await runDaily(f.options)).result,'checkin_rejected');
  await runDaily(f.options);
  assert.equal(posts(f.calls).length,1);
});
test('missing ticket stops before claiming a submission; adding authorization allows the scheduled attempt',async t=>{
  let available=false;
  const f=setup(t,{prepareCheckinAuthorization:async()=>{if(!available)throw new CheckinAuthorizationError('checkin_ticket_missing');}});
  const out=await runWithRetries(f.options);
  assert.equal(out.result,'need_authorization');assert.equal(out.reason,'checkin_ticket_missing');
  assert.equal(out.submitted,false);assert.equal(posts(f.calls).length,0);
  assert.equal(f.store.read('submission-checkin-'+DATE+'.json'),null);
  available=true;
  assert.equal((await runDaily(f.options)).result,'success');assert.equal(posts(f.calls).length,1);
});
test('dry-run and preflight require authorization and never claim or submit',async t=>{
  const f=setup(t,{prepareCheckinAuthorization:async()=>{throw new CheckinAuthorizationError('checkin_ticket_missing');}});
  assert.equal((await runDaily({...f.options,dryRun:true})).result,'need_authorization');
  assert.equal((await inspect({...f.options,mode:'preflight'})).result,'need_authorization');
  assert.equal(posts(f.calls).length,0);assert.equal(f.store.read('submission-checkin-'+DATE+'.json'),null);
});
test('school authorization rejection remains explicit through recovery and never repeats the POST',async t=>{
  for(const code of [46001,46002,46003]) {
    const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);return {code,ok:false,msg:'private response payload'};}});
    const out=await runWithRetries(f.options);
    assert.equal(out.result,'need_authorization');assert.equal(out.reason,'checkin_ticket_rejected');assert.equal(out.code,code);
    assert.equal((await runDaily(f.options)).result,'need_authorization');assert.equal(posts(f.calls).length,1);
    const log=fs.readdirSync(path.join(f.store.dir,'logs')).map(x=>fs.readFileSync(path.join(f.store.dir,'logs',x),'utf8')).join('');
    assert.match(log,/checkin_authorization_rejected/);assert.doesNotMatch(log,/private response payload/);
    f.setRecord(saved());assert.equal((await runDaily(f.options)).result,'already_done');
  }
});
test('saved school success takes precedence over a ticket rejection response',async t=>{
  const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);f.setRecord(saved());return {code:46001,ok:false};}});
  assert.equal((await runDaily(f.options)).result,'success');assert.equal(posts(f.calls).length,1);
});
test('unknown check-in response is reconciled after restart without another POST',async t=>{
  const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);throw new BusinessError('transport_error');}});
  assert.equal((await runWithRetries(f.options)).result,'unknown');
  assert.equal((await runDaily(f.options)).result,'unknown');
  assert.equal(posts(f.calls).length,1);
});
test('lost response is successful only if the school saved CHECKED_IN',async t=>{
  const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);f.setRecord(saved());throw new BusinessError('transport_error');}});
  assert.equal((await runDaily(f.options)).result,'success');assert.equal(posts(f.calls).length,1);
});
test('restart reconciliation keeps the authenticated context open until saved-record verification completes',async t=>{
  const f=setup(t);let closed=false,reads=0;
  f.store.claimSubmission(DATE,'synthetic-existing-claim');
  f.options.open=async()=>({close:async()=>{closed=true;}});
  f.adapter.getToday=async()=>{
    if(closed)throw new Error('context closed before verification');
    return ++reads===1?pending():saved();
  };
  assert.equal((await runDaily(f.options)).result,'success');
  assert.equal(reads,2);assert.equal(closed,true);assert.equal(posts(f.calls).length,0);
});
test('expired authentication, stale business date and poor accuracy stop all POSTs',async t=>{
  for(const [overrides,result] of [
    [{authenticate:async()=>{throw new BusinessError('need_login');}},'need_login'],
    [{getToday:async()=>ok({businessDate:'2026-10-09',recordStatusCode:'PENDING'})},'unknown'],
    [{getLocation:async()=>({...geo,accuracy:201})},'location_fail'],
  ]) {const f=setup(t,overrides);assert.equal((await runDaily(f.options)).result,result);assert.equal(posts(f.calls).length,0);}
});
test('completed records, exemption and dry-run never submit',async t=>{
  for(const status of ['CHECKED_IN','EXEMPT']) {
    const f=setup(t);f.setRecord(ok({businessDate:DATE,recordStatusCode:status}));
    assert.equal((await runDaily(f.options)).result,'already_done');assert.equal(posts(f.calls).length,0);
  }
  const f=setup(t);
  const out=await runDaily({...f.options,config:{...DEFAULTS,submissionsEnabled:false},dryRun:true});
  assert.equal(out.result,'dry_run_ready');assert.equal(out.operation,'checkin');assert.equal(posts(f.calls).length,0);
  assert.equal(f.store.read('submission-checkin-'+DATE+'.json'),null);
});
test('fresh record change after preparation prevents submitting',async t=>{
  let reads=0;const f=setup(t,{getToday:async()=>++reads===1?pending():saved()});
  assert.equal((await runDaily(f.options)).result,'already_done');assert.equal(posts(f.calls).length,0);
});
test('logs and journals omit precise coordinates and check-in bodies',async t=>{
  const f=setup(t);await runDaily(f.options);
  const journal=fs.readFileSync(f.store.file('submission-checkin-'+DATE+'.json'),'utf8');
  const logs=fs.readdirSync(path.join(f.store.dir,'logs')).map(x=>fs.readFileSync(path.join(f.store.dir,'logs',x),'utf8')).join('');
  for(const text of [journal,logs]){assert.ok(!text.includes('latitude'));assert.ok(!text.includes('longitude'));assert.ok(!text.includes('synthetic-test-agent'));}
});
test('check-in window observes Shanghai business date and five-minute safety margin',()=>{
  assert.equal(checkinWindow(schedule(),DATE,NOW).result,'open');
  assert.equal(checkinWindow(schedule(),DATE,new Date(DATE+'T23:25:00+08:00')).result,'window_missed');
  assert.equal(checkinWindow(schedule(),DATE,new Date('2026-10-10T16:00:00Z')).result,'window_missed');
});
test('malformed dormitory circles fail closed',()=>{
  assert.throws(()=>findDorm(geo,ok([{...geo,radiusMeter:100},{latitude:0,longitude:0,radiusMeter:-1}])));
});
test('atomic claims and locks prevent concurrent or repeated check-in submission',t=>{
  const {store}=setup(t);const release=store.acquire();assert.equal(store.acquire(),null);release();assert.ok(store.acquire());
  assert.equal(store.claimSubmission(DATE,'hash'),true);assert.equal(store.claimSubmission(DATE,'other'),false);
  assert.throws(()=>store.claimSubmission(DATE,'hash','report'));assert.throws(()=>store.file('../secret'));
});
test('scheduler uses Shanghai time, catch-up, daily marker, deferred windows and session interval',async t=>{
  const {store}=setup(t);
  assert.equal(dueReport(DEFAULTS,{},new Date(`${DATE}T22:29:00+08:00`)),false);
  assert.equal(dueReport(DEFAULTS,{},NOW),true);
  assert.equal(dueReport(DEFAULTS,{},new Date(`${DATE}T23:00:00+08:00`)),false);
  let reportCalls=0;
  const report=async()=>{reportCalls++;return reportCalls===1?{result:'window_not_open',businessDate:DATE,nextAttemptAt:`${DATE}T15:30:00Z`}:{result:'success',businessDate:DATE};};
  assert.equal((await tick({config:DEFAULTS,store,now:NOW,report})).action,'report');
  assert.equal(dueReport(DEFAULTS,store.read('scheduler.json'),new Date(`${DATE}T23:29:00+08:00`)),false);
  assert.equal((await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:30:00+08:00`),report})).result.result,'success');
  assert.equal(dueReport(DEFAULTS,store.read('scheduler.json'),NOW),false);
  const session=async()=>({result:'session_valid'});
  assert.equal((await tick({config:DEFAULTS,store,now:NOW,session})).action,'session');
  assert.equal((await tick({config:DEFAULTS,store,now:NOW,session})).action,'idle');
});
test('scheduler retries a pre-POST transient failure within the bounded catch-up interval',async t=>{
  const {store}=setup(t);let calls=0;
  const report=async()=>++calls===1?{result:'location_fail',submitted:false}:{result:'success',businessDate:DATE,submitted:true};
  await tick({config:DEFAULTS,store,now:NOW,report});assert.equal(store.read('scheduler.json').lastReportDate,undefined);
  await tick({config:DEFAULTS,store,now:new Date(`${DATE}T22:32:00+08:00`),report});assert.equal(calls,2);assert.equal(store.read('scheduler.json').lastReportDate,DATE);
});
test('scheduler resumes after new authorization arrives without an earlier submission claim',async t=>{
  let available=false;
  const f=setup(t,{prepareCheckinAuthorization:async()=>{if(!available)throw new CheckinAuthorizationError('checkin_ticket_missing');}});
  const report=()=>runWithRetries(f.options);
  const first=await tick({config:DEFAULTS,store:f.store,now:NOW,report});
  assert.equal(first.result.result,'need_authorization');
  assert.equal(f.store.read('scheduler.json').lastReportDate,undefined);
  available=true;
  const next=await tick({config:DEFAULTS,store:f.store,now:new Date(`${DATE}T22:32:00+08:00`),report});
  assert.equal(next.result.result,'success');assert.equal(posts(f.calls).length,1);
  assert.equal(f.store.read('scheduler.json').completionDate,DATE);
});
test('scheduler never retries ambiguous submitted outcomes',async t=>{
  const {store}=setup(t);let calls=0;
  const report=async()=>{calls++;return {result:'unknown',submitted:true};};
  await tick({config:DEFAULTS,store,now:NOW,report});
  await tick({config:DEFAULTS,store,now:new Date(`${DATE}T22:32:00+08:00`),report,session:async()=>({result:'session_valid'})});
  assert.equal(calls,1);
});
test('sleep past the hard cutoff cannot resume a daily attempt',async t=>{
  const {store}=setup(t);let calls=0;
  const report=async()=>{calls++;return {result:'location_fail',submitted:false};};
  await tick({config:DEFAULTS,store,now:NOW,report});
  await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:56:00+08:00`),report,session:async()=>({result:'session_valid'})});
  assert.equal(calls,1);
});
test('missed normal trigger is recovered before cutoff, completion prevents later backup',async t=>{
  const {store}=setup(t);let calls=0;
  const report=async()=>{calls++;return {result:'success',businessDate:DATE,submitted:true};};
  const out=await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:40:00+08:00`),report});
  assert.equal(out.action,'recovery');assert.equal(calls,1);
  await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:50:00+08:00`),report,session:async()=>({result:'session_valid'})});assert.equal(calls,1);
});
test('expired normal retries leave a ten-minute watchdog backup channel',async t=>{
  const {store}=setup(t);let calls=0;
  const report=async()=>++calls===1?{result:'location_fail',submitted:false}:{result:'already_done',businessDate:DATE};
  await tick({config:DEFAULTS,store,now:NOW,report});
  assert.equal((await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:10:00+08:00`),report})).action,'recovery');assert.equal(calls,2);
});
test('watchdog reads persisted unknown check-in instead of issuing a second POST',async t=>{
  const f=setup(t,{submitCheckin:async body=>{f.calls.push(['checkin',body]);throw new BusinessError('transport_error');}});
  await runDaily(f.options);
  const out=await tick({config:DEFAULTS,store:f.store,now:new Date(`${DATE}T23:10:00+08:00`),report:()=>runWithRetries(f.options)});
  assert.equal(out.result.result,'unknown');assert.equal(posts(f.calls).length,1);
});
test('preflight checks actual location without any POST, once during the early interval',async t=>{
  const f=setup(t);let calls=0;
  const preflight=async()=>{calls++;return inspect({...f.options,mode:'preflight'});};
  assert.equal((await tick({config:DEFAULTS,store:f.store,now:new Date(`${DATE}T22:10:00+08:00`),preflight})).result.result,'preflight_ready');
  await tick({config:DEFAULTS,store:f.store,now:new Date(`${DATE}T22:20:00+08:00`),preflight,session:async()=>({result:'session_valid'})});
  assert.equal(calls,1);assert.equal(posts(f.calls).length,0);
});
test('stale completed business date does not clear current-day failure',async t=>{
  const {store}=setup(t);
  await tick({config:DEFAULTS,store,now:NOW,report:async()=>({result:'unknown',submitted:true})});
  const out=await tick({config:DEFAULTS,store,now:new Date(`${DATE}T23:10:00+08:00`),report:async()=>({result:'already_done',businessDate:'2026-10-09'})});
  assert.equal(out.result.result,'unknown');assert.equal(store.read('scheduler.json').completionDate,undefined);
  assert.notEqual(store.read('failure-'+DATE+'.json').result,'resolved');
});
test('long configured catch-up cannot bypass the hard cutoff',async t=>{
  const {store}=setup(t);const config=validateConfig({...DEFAULTS,catchUpMinutes:120});let calls=0;
  const now=new Date(`${DATE}T23:56:00+08:00`);
  assert.equal(dueReport(config,{},now),false);
  await tick({config,store,now,report:async()=>{calls++;return {result:'unknown'};},session:async()=>({result:'session_valid'})});
  assert.equal(calls,0);
});
test('configured cutoff is rechecked after slow location, before any POST',async t=>{
  const f=setup(t);let clock=new Date(`${DATE}T22:59:00+08:00`);
  f.adapter.getLocation=async()=>{clock=new Date(`${DATE}T23:01:00+08:00`);return geo;};
  const out=await runDaily({...f.options,config:{...DEFAULTS,recoveryCutoff:'23:00'},now:()=>clock});
  assert.equal(out.result,'window_missed');assert.equal(out.reason,'recovery_cutoff_reached');assert.equal(posts(f.calls).length,0);
});
test('before both windows the earliest check-in start is selected',async t=>{
  const f=setup(t,{getSchedule:async()=>ok({...schedule().data,studentSubmissionStartOffsetMinute:1380,studentSubmissionEndOffsetMinute:1410})});
  const out=await runDaily({...f.options,now:()=>new Date(`${DATE}T21:00:00+08:00`)});
  assert.equal(out.result,'window_not_open');assert.equal(out.nextAttemptAt,`${DATE}T14:00:00.000Z`);assert.equal(posts(f.calls).length,0);
});
