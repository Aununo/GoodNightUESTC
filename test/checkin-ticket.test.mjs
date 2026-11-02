import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { parseTicketInput, createCheckinTicketManager, checkinTicketStatus } from '../src/checkin-ticket.mjs';
import { createUestcAdapter } from '../src/adapters/uestc.mjs';

const PAGE='https://jzsz.uestc.edu.cn/daily-checkin-h5/index.html';
const cli=fileURLToPath(new URL('../bin/goodnight.mjs',import.meta.url));
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-ticket-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);store.write('config.json',DEFAULTS);
  const ctx={};
  const manager=createCheckinTicketManager(store);manager.bindIdentity('synthetic-user');
  return {dir,store,ctx,manager};
}

test('imports accept opaque tickets and exact school entry URLs, rejecting ambiguous or injected input',()=>{
  assert.equal(parseTicketInput('synthetic-ticket\n'),'synthetic-ticket');
  assert.equal(parseTicketInput(PAGE+'?appId=294&checkinTicket=synthetic%2Bticket'),'synthetic+ticket');
  assert.equal(parseTicketInput(PAGE+'#/pages/home?checkinTicket=synthetic-ticket'),'synthetic-ticket');
  for(const value of ['', 'a\r\nX-Injected: b', 'a b', 'x'.repeat(8193),
    'https://untrusted.invalid/?checkinTicket=synthetic',
    'https://jzsz.uestc.edu.cn.evil.invalid/daily-checkin-h5/index.html?checkinTicket=synthetic',
    'http://jzsz.uestc.edu.cn/daily-checkin-h5/index.html?checkinTicket=synthetic',
    PAGE+'?checkinTicket=a&checkinTicket=b', PAGE+'?checkinTicket=a#/home?checkinTicket=b',
    PAGE+'?checkinTicket=a%0D%0Ab', PAGE]) {
    assert.throws(()=>parseTicketInput(value),{code:'need_authorization'});
  }
});
test('only an explicit import supplies authorization; it persists privately and stays bound to the identity',async t=>{
  const f=setup(t);
  await assert.rejects(f.manager.require(),{reason:'checkin_ticket_missing'});
  assert.deepEqual(f.manager.import('synthetic-imported'),{result:'authorization_available',serverVerified:false});
  assert.equal(await f.manager.require(),'synthetic-imported');
  if(process.platform!=='win32')assert.equal(fs.statSync(f.store.file('checkin-ticket.json')).mode&0o777,0o600);
  const next=createCheckinTicketManager(f.store);next.bindIdentity('synthetic-user');
  assert.equal(await next.require(),'synthetic-imported');
  next.bindIdentity('different-user');
  await assert.rejects(next.require(),{reason:'checkin_ticket_identity_mismatch'});
});
test('a newer import replaces the saved ticket',async t=>{
  const f=setup(t);f.manager.import('synthetic-old');f.manager.import('synthetic-new');
  const next=createCheckinTicketManager(f.store);next.bindIdentity('synthetic-user');
  assert.equal(await next.require(),'synthetic-new');
});
test('rejected tickets are removed, cannot be re-imported, and can be replaced by new authorization',async t=>{
  const f=setup(t);f.manager.import('synthetic-rejected');
  await f.manager.require();f.manager.reject(46001);
  assert.doesNotMatch(JSON.stringify(f.store.read('checkin-ticket.json')),/synthetic-rejected/);
  assert.equal(checkinTicketStatus(f.store).state,'rejected');
  await assert.rejects(f.manager.require(),{reason:'checkin_ticket_rejected'});
  assert.throws(()=>f.manager.import('synthetic-rejected'),{reason:'checkin_ticket_rejected'});
  f.manager.import('synthetic-fresh');assert.equal(await f.manager.require(),'synthetic-fresh');
});
test('public status and CLI never reveal ticket values or account identity hashes',t=>{
  const f=setup(t);f.manager.import('synthetic-secret-ticket');
  const status=checkinTicketStatus(f.store);
  assert.equal(status.state,'available');assert.equal(status.serverVerified,false);
  const output=execFileSync(process.execPath,[cli,'status','--data-dir',f.dir],{encoding:'utf8'});
  assert.doesNotMatch(output,/synthetic-secret-ticket|identityHash|fingerprint/);
});
test('CLI refuses readable-by-others ticket files before starting authentication',{skip:process.platform==='win32'},t=>{
  const f=setup(t),input=path.join(f.dir,'incoming.txt');fs.writeFileSync(input,'synthetic-private-ticket',{mode:0o644});
  const result=spawnSync(process.execPath,[cli,'authorize','--data-dir',f.dir,'--ticket-file',input],{encoding:'utf8'});
  assert.equal(result.status,3);assert.match(result.stderr,/600/);
  assert.doesNotMatch(result.stdout+result.stderr,/synthetic-private-ticket/);
  assert.equal(f.store.read('checkin-ticket.json'),null);
});
test('adapter makes no submit request without authorization and sends tickets only on the check-in endpoint',async t=>{
  const f=setup(t),calls=[];
  let rejected=false;
  f.ctx.request={fetch:async(url,opts)=>{
    calls.push({url,opts});
    return {status:()=>200,json:async()=>url.endsWith('/auth/user-info')
      ?{code:0,data:{userData:{id:'synthetic-user'}}}
      :rejected?{code:46002,ok:false}:{code:0,data:{}}};
  }};
  f.ctx.cookies=async()=>[];
  const api=createUestcAdapter(f.ctx,DEFAULTS,{store:f.store});await api.authenticate();
  await assert.rejects(api.submitCheckin({}),{reason:'checkin_ticket_missing'});
  assert.equal(calls.length,1);
  api.importCheckinTicket('synthetic-authorized');
  await api.getToday();await api.getSchedule();await api.getCheckinLocations();
  assert.ok(calls.every(c=>c.opts.headers['X-Checkin-Ticket']===undefined));
  rejected=true;const response=await api.submitCheckin({synthetic:true});
  assert.equal(response.code,46002);
  assert.equal(calls.at(-1).opts.headers['X-Checkin-Ticket'],'synthetic-authorized');
  assert.equal(calls.at(-1).opts.maxRedirects,0);
  assert.equal(checkinTicketStatus(f.store).state,'rejected');
  await assert.rejects(api.submitCheckin({}),{reason:'checkin_ticket_rejected'});
  assert.equal(calls.filter(c=>c.opts.method==='POST').length,1);
});
