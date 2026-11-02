import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {validateConfig,loadConfig} from '../src/config.mjs';
import {addAccount,listAccounts,selectAccount,accountDirectory,bindAccountIdentity} from '../src/accounts.mjs';
import {tickAccounts,daemonAccounts} from '../src/multi-daemon.mjs';
import {runDaily} from '../src/runner.mjs';
import {createUestcAdapter} from '../src/adapters/uestc.mjs';

// Synthetic date and account labels; never copy deployment identities into fixtures.
const DATE='2030-01-02',NOW=new Date(DATE+'T21:15:00+08:00');
const cli=fileURLToPath(new URL('../bin/goodnight.mjs',import.meta.url));
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-accounts-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  store.write('config.json',validateConfig({reportTime:'21:15',browserChannel:'chromium',notifications:false,
    submissionsEnabled:true,autoRelogin:true,locationProvider:'fixed',fixedLocation:{latitude:10,longitude:10,accuracy:20}}));
  return store;
}
test('adding an account preserves original state and starts with no credentials or coordinates',t=>{
  const root=setup(t),before=fs.readFileSync(root.file('config.json'),'utf8');
  root.write('last-result.json',{result:'success',businessDate:DATE});root.write('scheduler.json',{lastReportDate:DATE});
  fs.mkdirSync(path.join(root.dir,'profile'));fs.writeFileSync(path.join(root.dir,'profile','private-marker'),'synthetic-cookie');
  assert.equal(selectAccount(root.dir).dataDir,root.dir);
  const account=addAccount(root.dir,'student-b',{label:'示例账号B'}),config=loadConfig(account.dataDir);
  assert.equal(account.reportTime,'21:15');assert.equal(config.browserChannel,'chromium');
  assert.equal(config.submissionsEnabled,false);assert.equal(config.autoRelogin,false);
  assert.equal(config.fixedLocation,null);assert.equal(config.locationProvider,'browser');
  assert.equal(fs.existsSync(path.join(account.dataDir,'profile')),false);
  assert.equal(fs.existsSync(path.join(account.dataDir,'scheduler.json')),false);
  assert.equal(fs.existsSync(path.join(account.dataDir,'last-result.json')),false);
  assert.equal(fs.readFileSync(root.file('config.json'),'utf8'),before);
  assert.deepEqual(root.read('last-result.json'),{result:'success',businessDate:DATE});
  assert.equal(listAccounts(root.dir).length,2);
  assert.equal(selectAccount(root.dir,'default').dataDir,root.dir);
});
test('unknown IDs, directory escapes and shared symlink directories are rejected',t=>{
  const root=setup(t);
  for(const id of ['../default','../','/tmp/other','a/b','a\\b','A','',null])assert.throws(()=>addAccount(root.dir,id));
  assert.throws(()=>selectAccount(root.dir,'missing'),{code:'account_not_found'});
  addAccount(root.dir,'student-b');
  assert.throws(()=>addAccount(root.dir,'student-b'),{code:'account_already_exists'});
  fs.symlinkSync(root.dir,path.join(root.dir,'accounts','linked'),'dir');
  assert.throws(()=>accountDirectory(root.dir,'linked'),{code:'account_directory_symlink'});
  root.write('accounts.json',{version:1,accounts:[{id:'default',label:'a'},{id:'default',label:'b'}]});
  assert.throws(()=>listAccounts(root.dir),{code:'duplicate_account_id'});
});
test('school identities bind once and duplicate accounts or later identity changes stop authentication',async t=>{
  const root=setup(t),account=addAccount(root.dir,'student-b'),second=new Store(account.dataDir);
  bindAccountIdentity(root,{id:'synthetic-user-one'});
  bindAccountIdentity(root,{id:'synthetic-user-one'});
  assert.throws(()=>bindAccountIdentity(root,{id:'synthetic-user-two'}),{code:'account_identity_mismatch'});
  assert.throws(()=>bindAccountIdentity(second,{id:'synthetic-user-one'}),{code:'school_identity_already_registered'});
  assert.equal(second.read('identity.json'),null);
  assert.throws(()=>bindAccountIdentity(second,{}),{code:'school_identity_unavailable'});
  bindAccountIdentity(second,{id:'synthetic-user-two'});
  const ctx={request:{fetch:async()=>({status:()=>200,json:async()=>({code:0,data:{userData:{id:'synthetic-user-one'}}})})},cookies:async()=>[]};
  await assert.rejects(createUestcAdapter(ctx,loadConfig(second.dir),{store:second}).authenticate(),{code:'account_identity_mismatch'});
  for(const store of [root,second])assert.doesNotMatch(JSON.stringify(store.read('identity.json')),/synthetic-user/);
});
test('both accounts can submit once on the same date using only their own configurations and journals',async t=>{
  const root=setup(t),second=new Store(addAccount(root.dir,'student-b').dataDir);
  second.write('config.json',validateConfig({...loadConfig(second.dir),submissionsEnabled:true,
    locationProvider:'fixed',fixedLocation:{latitude:11,longitude:11,accuracy:20}}));
  const requests=[];
  for(const store of [root,second,root,second]) {
    const config=loadConfig(store.dir);let done=!!store.read('submission-checkin-'+DATE+'.json');
    const out=await runDaily({config,store,now:()=>NOW,sleep:async()=>{},
      open:async(_c,dir)=>({dir,close:async()=>{}}),
      adapterFactory:ctx=>({authenticate:async()=>{},
        prepareCheckinAuthorization:async()=>({result:'authorization_available',serverVerified:false}),
        getToday:async()=>({code:0,data:{businessDate:DATE,recordStatusCode:done?'CHECKED_IN':'PENDING'}}),
        getSchedule:async()=>({code:0,data:{studentCheckinStartOffsetMinute:1260,studentCheckinEndOffsetMinute:1410}}),
        getLocation:async()=>config.fixedLocation,getCheckinLocations:async()=>({code:0,data:[{...config.fixedLocation,radiusMeter:100}]}),
        getAddress:async()=>'',getUserAgent:async()=>'synthetic',
        submitCheckin:async body=>{requests.push({dir:ctx.dir,latitude:body.latitude});done=true;return {code:0};},
      }),
    });
    assert.ok(['success','already_done'].includes(out.result));
  }
  assert.deepEqual(requests,[{dir:root.dir,latitude:10},{dir:second.dir,latitude:11}]);
  assert.equal(root.read('submission-checkin-'+DATE+'.json').state,'success');
  assert.equal(second.read('submission-checkin-'+DATE+'.json').state,'success');
});
test('a held browser lock or a completed date on one account does not block another account',async t=>{
  const root=setup(t),second=new Store(addAccount(root.dir,'student-b').dataDir);
  second.write('config.json',validateConfig({...loadConfig(second.dir),submissionsEnabled:true}));
  root.write('scheduler.json',{lastReportDate:DATE,completionDate:DATE,lastSessionAt:NOW.toISOString()});
  const unlock=root.acquire(),calls=[];
  try {
    const outcomes=await tickAccounts({store:root,now:()=>NOW,tickAccount:async options=>{
      calls.push(options.store.dir);
      const {tick}=await import('../src/daemon.mjs');
      return tick({...options,report:async()=>({result:'success',businessDate:DATE}),notify:async()=>{}});
    }});
    assert.deepEqual(outcomes.map(x=>x.action),['idle','report']);
    assert.equal(second.read('scheduler.json').completionDate,DATE);
    assert.deepEqual(calls,[root.dir,second.dir]);
    assert.equal(root.acquire(),null);
  }finally{unlock();}
});
test('one failing account cannot prevent the next account; configurations reload every cycle',async t=>{
  const root=setup(t),second=new Store(addAccount(root.dir,'student-b').dataDir);
  const calls=[];let active=0,maxActive=0;
  const tickAccount=async ({store,config})=>{
    calls.push({dir:store.dir,enabled:config.submissionsEnabled});active++;maxActive=Math.max(maxActive,active);
    await Promise.resolve();active--;
    if(store.dir===root.dir)throw new Error('synthetic private error');
    return {action:config.submissionsEnabled?'report':'disabled'};
  };
  assert.deepEqual((await tickAccounts({store:root,now:()=>NOW,tickAccount})).map(x=>x.action),['account_error','disabled']);
  second.write('config.json',validateConfig({...loadConfig(second.dir),submissionsEnabled:true}));
  assert.deepEqual((await tickAccounts({store:root,now:()=>NOW,tickAccount})).map(x=>x.action),['account_error','report']);
  assert.equal(maxActive,1);assert.equal(calls.length,4);
  assert.doesNotMatch(fs.readFileSync(path.join(root.dir,'logs',new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})+'.jsonl'),'utf8'),/synthetic private/);
  fs.writeFileSync(second.file('config.json'),'invalid-json');
  assert.deepEqual((await tickAccounts({store:root,now:()=>NOW,tickAccount})).map(x=>x.action),['account_error','account_error']);
});
test('multi-account daemon has its own singleton lock and releases it on shutdown',async t=>{
  const root=setup(t),release=root.acquire('accounts-daemon.lock');
  await assert.rejects(daemonAccounts({store:root}),/已经运行/);release();
  const abort=new AbortController();abort.abort();
  await daemonAccounts({store:root,signal:abort.signal});
  assert.equal(fs.existsSync(root.file('accounts-daemon.lock')),false);
  const original=root.acquire(),supervisor=root.acquire('accounts-daemon.lock');
  assert.ok(original);assert.ok(supervisor);original();supervisor();
});
test('CLI selects named accounts explicitly, reports all statuses and never falls back for typos',t=>{
  const root=setup(t);
  const created=JSON.parse(execFileSync(process.execPath,[cli,'account','add','student-b','--label','示例账号B','--data-dir',root.dir],{encoding:'utf8'}));
  assert.equal(created.id,'student-b');assert.equal(created.submissionsEnabled,false);
  const status=JSON.parse(execFileSync(process.execPath,[cli,'status','--account','student-b','--data-dir',root.dir],{encoding:'utf8'}));
  assert.equal(status.dataDir,accountDirectory(root.dir,'student-b'));assert.equal(status.lastCheckin,null);
  const all=JSON.parse(execFileSync(process.execPath,[cli,'status','--all-accounts','--data-dir',root.dir],{encoding:'utf8'}));
  assert.deepEqual(all.accounts.map(x=>x.id),['default','student-b']);
  for(const args of [['status','--account','typo'],['run','--all-accounts'],['status','--account','student-b','--all-accounts'],['service','install','--account','student-b']]) {
    const result=spawnSync(process.execPath,[cli,...args,'--data-dir',root.dir],{encoding:'utf8'});
    assert.equal(result.status,3);
  }
});
