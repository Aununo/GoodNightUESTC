import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, configuredLocation, validateConfig } from '../src/config.mjs';
import { createUestcAdapter } from '../src/adapters/uestc.mjs';
import { runDaily, inspect } from '../src/runner.mjs';
import { tick } from '../src/daemon.mjs';
import { Store } from '../src/store.mjs';
import { renderService } from '../src/service.mjs';

const fixed={latitude:10,longitude:10,accuracy:20}; // Synthetic, not a campus position.
test('fixed location is explicit and does not invoke browser geolocation',async()=>{
  const config=validateConfig({locationProvider:'fixed',fixedLocation:fixed});
  const api=createUestcAdapter({},config);
  assert.deepEqual(await api.getLocation(),fixed);
  const result=await api.getLocation();result.latitude=0;
  assert.equal((await api.getLocation()).latitude,10);
  assert.equal(configuredLocation(DEFAULTS),null);
});
test('invalid or ambiguous location settings cannot fall back to a guessed position',()=>{
  for(const value of [null,{}, {...fixed,latitude:91}, {...fixed,longitude:181},
    {...fixed,accuracy:-1}, {...fixed,accuracy:201}, {...fixed,accuracy:NaN},
    {...fixed,longitude:'10'}, {...fixed,unexpected:true}]) {
    assert.throws(()=>validateConfig({locationProvider:'fixed',fixedLocation:value}));
  }
  assert.throws(()=>validateConfig({locationProvider:'automatic'}));
  assert.throws(()=>validateConfig({locationProvider:'browser',fixedLocation:fixed}));
  assert.throws(()=>validateConfig({submissionsEnabled:'false'}));
});
test('disabled submissions do not open a browser, touch school APIs, or consume a schedule',async()=>{
  const config=validateConfig({submissionsEnabled:false});
  const forbidden=()=>{throw new Error('disabled task performed work');};
  assert.deepEqual(await runDaily({config,open:forbidden}),{result:'submission_disabled',submitted:false});
  assert.deepEqual(await tick({config,store:{read:forbidden,write:forbidden},report:forbidden,session:forbidden,preflight:forbidden}),{action:'disabled'});
});
test('server service starts from the user default target without a graphical session',()=>{
  const unit=renderService({platform:'linux',home:'/home/test',node:'/usr/bin/node',entrypoint:'/opt/goodnight/bin/goodnight.mjs',server:true}).files[0].content;
  assert.match(unit,/WantedBy=default.target/);
  assert.doesNotMatch(unit,/graphical-session/);
  assert.match(unit,/RestartSec=15/);
  assert.match(unit,/UMask=0077/);
});
test('locations inspection only authenticates and reads available dormitory data',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'goodnight-locations-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[];
  const out=await inspect({
    config:DEFAULTS,store:new Store(dir),mode:'locations',
    open:async()=>({close:async()=>calls.push('close')}),
    adapterFactory:()=>({
      authenticate:async()=>calls.push('auth'),
      getCheckinLocations:async()=>{calls.push('locations');return {code:0,data:[{name:'synthetic',...fixed,radiusMeter:100}]};},
    }),
  });
  assert.equal(out.result,'locations_read');
  assert.equal(out.locations.length,1);
  assert.deepEqual(calls,['auth','locations','close']);
});
