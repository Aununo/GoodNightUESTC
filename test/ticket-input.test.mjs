import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTicketStdin } from '../src/ticket-input.mjs';
import { Store } from '../src/store.mjs';
import { DEFAULTS } from '../src/config.mjs';

test('ticket stdin reads chunked data without treating shell metacharacters as code', async () => {
  const data = 'synthetic-$(echo forbidden)`not-code`';
  assert.equal(await readTicketStdin(Readable.from([Buffer.from(data.slice(0,10)), Buffer.from(data.slice(10))])), data);
});

test('ticket stdin enforces byte limits, refuses terminal echo, and bounds a stalled SSH input', async () => {
  await assert.rejects(readTicketStdin(Readable.from([Buffer.alloc(32769)])), /32 KiB/);
  await assert.rejects(readTicketStdin(Readable.from(['中'.repeat(12000)])), /32 KiB/);
  await assert.rejects(readTicketStdin({isTTY:true}), /回显终端/);
  const stalled = new PassThrough();
  await assert.rejects(readTicketStdin(stalled, {timeoutMs:20}), /超时/);
  stalled.destroy();
  const failed = new PassThrough(), result = readTicketStdin(failed);
  failed.destroy(new Error('synthetic-private-data'));
  await assert.rejects(result, error => error.message === '无法读取票据标准输入');
});

test('CLI validates stdin before browser access and never exposes input on failure or a busy account', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-stdin-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  store.write('config.json',DEFAULTS);
  store.write('run.lock',{pid:process.pid,token:'synthetic-lock'});
  const cli=fileURLToPath(new URL('../bin/goodnight.mjs',import.meta.url));
  const invoke=(args,input)=>spawnSync(process.execPath,[cli,...args,'--data-dir',dir],{input,encoding:'utf8',timeout:5000});
  for(const input of ['', 'synthetic-private\r\nX-Injected: yes',
    'https://untrusted.invalid/?checkinTicket=synthetic-private', 'x'.repeat(32769)]) {
    const result=invoke(['authorize','--ticket-stdin'],input);
    assert.equal(result.status,3);
    assert.doesNotMatch(result.stdout+result.stderr,/synthetic-private/);
    assert.equal(store.read('checkin-ticket.json'),null);
    assert.equal(fs.existsSync(path.join(dir,'profile')),false);
  }
  for(const args of [['status','--ticket-stdin'],['authorize','--ticket-stdin','--ticket-file','unused']]) {
    const result=invoke(args,'synthetic-private');
    assert.equal(result.status,3);
    assert.doesNotMatch(result.stdout+result.stderr,/synthetic-private/);
  }
  const result=invoke(['authorize','--ticket-stdin'],
    'https://jzsz.uestc.edu.cn/daily-checkin-h5/index.html?checkinTicket=synthetic-private');
  assert.equal(result.status,3);
  assert.equal(JSON.parse(result.stdout).result,'already_running');
  assert.doesNotMatch(result.stdout+result.stderr,/synthetic-private/);
  assert.equal(store.read('checkin-ticket.json'),null);
});

test('restricted iPhone command fixes the account and rejects shell commands before reading input', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-iphone-ssh-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  store.write('config.json',DEFAULTS);
  store.write('run.lock',{pid:process.pid,token:'synthetic-lock'});
  const wrapper=fileURLToPath(new URL('../scripts/authorize-from-iphone.mjs',import.meta.url));
  const invoke=(command,args=['default'],input='')=>spawnSync(process.execPath,[wrapper,...args],{
    env:{...process.env,GOODNIGHT_HOME:dir,SSH_ORIGINAL_COMMAND:command},input,encoding:'utf8',timeout:5000,
  });
  for(const command of ['', 'sh', 'goodnight-authorize; echo synthetic-injection', 'goodnight-authorize --account dorm13']) {
    const result=invoke(command,undefined,'synthetic-private');
    assert.equal(result.status,3);
    assert.doesNotMatch(result.stdout+result.stderr,/synthetic-injection|synthetic-private/);
  }
  assert.equal(invoke('goodnight-authorize',['../dorm13']).status,3);
  assert.equal(invoke('goodnight-authorize',['default','dorm13']).status,3);
  const status=invoke('goodnight-status');
  assert.equal(status.status,0);
  assert.equal(JSON.parse(status.stdout).checkinAuthorization.state,'missing');
  const whitespace=invoke('goodnight-status\n');
  assert.equal(whitespace.status,0);
  const auth=invoke('goodnight-authorize',undefined,'synthetic-private');
  assert.equal(auth.status,3);
  assert.equal(JSON.parse(auth.stdout).result,'already_running');
  assert.doesNotMatch(auth.stdout+auth.stderr,/synthetic-private/);
  assert.equal(store.read('last-iphone-request.json').result,'already_running');
  for(const input of ['', 'https://other.invalid/?checkinTicket=synthetic-private']) {
    const failed=invoke('goodnight-authorize',undefined,input);
    assert.equal(failed.status,3);
    const output=JSON.parse(failed.stdout);
    assert.equal(output.result,'error');
    assert.match(output.reason,/^invalid_(checkin_ticket|authorization_url)$/);
    assert.match(output.message,/剪贴板/);
    assert.equal(store.read('last-iphone-request.json').reason,output.reason);
    assert.equal(store.read('last-iphone-request.json').receivedBytes,Buffer.byteLength(input));
    assert.equal(store.read('last-iphone-request.json').inputKind,input?'url':'empty');
    assert.doesNotMatch(JSON.stringify(store.read('last-iphone-request.json'))+failed.stdout+failed.stderr,/synthetic-private/);
  }
  for(const name of fs.readdirSync(path.join(dir,'logs'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir,'logs',name),'utf8'),/synthetic-private|synthetic-injection/);
  }
});
