import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverSchoolSession } from '../src/auth-recovery.mjs';
import { createUestcAdapter } from '../src/adapters/uestc.mjs';

const NOW=new Date('2026-10-21T13:00:00Z');
function fixture({passwordPage=false,challenge=false,prefilled=true,loginSucceeds=true,untrusted=false,verifyFails=false,entryRequired=false}={}) {
  const data=new Map(),events=[];
  const store={read:(name,fallback)=>data.get(name)??fallback,write:(name,value)=>data.set(name,value),log:(name,value)=>events.push({name,value})};
  let url='about:blank',logins=0,closed=false,pages=0,businessBootstrapped=false;
  const submit={count:async()=>1,click:async()=>{logins++;if(loginSucceeds)url='https://jzsz.uestc.edu.cn/#/hall/home';}};
  const input={count:async()=>1,click:async()=>{},fill:async()=>{}};
  const form={
    count:async()=>1,
    waitFor:async()=>{},
    locator:selector=>selector.includes('input#')?input:submit,
    evaluate:async fn=>fn.toString().includes('actionOrigin')
      ?{usernamePrefilled:prefilled,passwordPrefilled:prefilled,challengeVisible:challenge,actionOrigin:'https://idas.uestc.edu.cn'}
      :challenge,
  };
  const page={
    bringToFront:async()=>{},
    route:async()=>{},url:()=>url,keyboard:{press:async()=>{}},
    goto:async target=>{if(target.endsWith('/daily-checkin/checkLogin'))businessBootstrapped=true;url=untrusted?'https://untrusted.example/':passwordPage&&target.includes('#/hall')?'https://idas.uestc.edu.cn/authserver/login':target;},
    locator:()=>form,close:async()=>{closed=true;},
  };
  const ctx={newPage:async()=>{pages++;return page;}};
  const options={store,now:()=>NOW,sleep:async()=>{},readLogin:()=>null,verify:async()=>{if(verifyFails||(entryRequired&&!businessBootstrapped))throw new Error('synthetic failure');}};
  return {ctx,options,store,data,events,logins:()=>logins,closed:()=>closed,pages:()=>pages};
}
test('valid cached SSO restores business authentication without submitting a password',async()=>{
  const f=fixture();assert.equal(await recoverSchoolSession(f.ctx,f.options),true);
  assert.equal(f.logins(),0);assert.equal(f.closed(),true);
  assert.equal(f.data.get('auth-recovery.json').state,'success');
});
test('application login entry bootstraps the business session before saved-record verification',async()=>{
  const f=fixture({entryRequired:true});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),true);assert.equal(f.logins(),0);
});
test('saved browser credentials permit exactly one normal school login and business verification',async()=>{
  const f=fixture({passwordPage:true});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),true);assert.equal(f.logins(),1);
  assert.equal(f.data.get('auth-recovery.json').state,'success');
});
test('authorized saved school entry is used when native autofill is unavailable',async()=>{
  const f=fixture({passwordPage:true,prefilled:false});
  f.options.readLogin=()=>({username:'synthetic-school-user',password:'synthetic-school-password'});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),true);assert.equal(f.logins(),1);
  const output=JSON.stringify([...f.data.values(),...f.events]);
  assert.ok(!output.includes('synthetic-school-user'));assert.ok(!output.includes('synthetic-school-password'));
});
test('challenge, unavailable saved password and unexpected origins stop before password submission',async()=>{
  for(const scenario of [{passwordPage:true,challenge:true},{passwordPage:true,prefilled:false},{untrusted:true}]) {
    const f=fixture(scenario);assert.equal(await recoverSchoolSession(f.ctx,f.options),false);
    assert.equal(f.logins(),0);assert.equal(f.data.get('auth-recovery.json').state,'manual_required');
  }
});
test('failed login is not retried after restart until a newer manual login is recorded',async()=>{
  const f=fixture({passwordPage:true,loginSucceeds:false});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),false);assert.equal(f.logins(),1);
  assert.equal(await recoverSchoolSession(f.ctx,f.options),false);assert.equal(f.logins(),1);assert.equal(f.pages(),1);
  f.store.write('login-result.json',{at:new Date(NOW.getTime()+1000).toISOString()});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),false);assert.equal(f.logins(),2);
});
test('crash after a recovery claim cannot cause another password POST',async()=>{
  const f=fixture({passwordPage:true});
  f.store.write('auth-recovery.json',{state:'attempting',at:NOW.toISOString()});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),false);assert.equal(f.pages(),0);
});
test('a page navigation alone is insufficient without successful business authentication',async()=>{
  const f=fixture({verifyFails:true});
  assert.equal(await recoverSchoolSession(f.ctx,f.options),false);
  assert.equal(f.data.get('auth-recovery.json').reason,'business_session_not_confirmed');
});
test('adapter attempts recovery only for explicit authentication expiry, never transport failure',async()=>{
  let recoveryCalls=0,expired=true,networkFailure=false;
  const ctx={request:{fetch:async()=>{
    if(networkFailure)throw new Error('private network failure');
    return {status:()=>200,json:async()=>expired?{code:5000}:{code:0,data:{}}};
  }},cookies:async()=>[]};
  const api=createUestcAdapter(ctx,{autoRelogin:true},{store:{read:()=>null},recover:async(_ctx,{verify})=>{
    recoveryCalls++;expired=false;await verify();return true;
  }});
  await api.authenticate();assert.equal(recoveryCalls,1);
  networkFailure=true;await assert.rejects(api.authenticate(),{code:'transport_error'});
  assert.equal(recoveryCalls,1);
});
