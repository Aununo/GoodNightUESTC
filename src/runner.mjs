import crypto from 'node:crypto';
import { launchBrowser } from './browser.mjs';
import { createUestcAdapter, BusinessError } from './adapters/uestc.mjs';
import { validateConfig } from './config.mjs';
import { apiSucceeded, todayState, summary, checkinWindow, checkinVerified, findDorm } from './policy.mjs';
import { CHECKIN_AUTH_CODES } from './checkin-ticket.mjs';
const sleepDefault = ms => new Promise(r => setTimeout(r, ms));
const failure = e => ['need_login','need_authorization'].includes(e?.code) ? e.code : 'unknown';
const failureReason = e => e?.code === 'need_authorization' ? e.reason : e instanceof BusinessError ? e.code : 'runtime_error';
const fingerprint = config => crypto.createHash('sha256')
  .update(JSON.stringify(['checkin',config.locationProvider,config.fixedLocation])).digest('hex');

// After an attempted check-in, only read the saved record; never issue a second POST.
export async function reconcile(adapter, date, config, {sleep=sleepDefault,emit=()=>{}}={}) {
  let confirmedPending=false;
  for(let attempt=1;attempt<=3;attempt++) {
    await sleep(1500*attempt);
    let record;
    try {record=await adapter.getToday();}
    catch(e) {
      confirmedPending=false;
      if(e.code==='need_login')return {result:'need_login',businessDate:date,operation:'checkin',submitted:true};
      continue;
    }
    emit('verification',{operation:'checkin',attempt,...summary(record)});
    if(checkinVerified(record,date))return {result:'success',businessDate:date,status:record.data.recordStatusCode,operation:'checkin',submitted:true};
    if(apiSucceeded(record)&&record.data?.businessDate===date&&todayState(record,new Date(date+'T22:30:00+08:00'))==='done')
      return {result:'already_done',...summary(record),operation:'checkin',submitted:true};
    if(record.data?.businessDate&&record.data.businessDate!==date)
      return {result:'unknown',reason:'business_date_changed',operation:'checkin',submitted:true};
    confirmedPending=apiSucceeded(record)&&record.data?.businessDate===date&&record.data.recordStatusCode==='PENDING';
  }
  return {result:'unknown',reason:'saved_record_not_confirmed',businessDate:date,operation:'checkin',submitted:true,confirmedPending};
}
async function submitAndVerify(adapter,date,config,store,body,options) {
  const name='submission-checkin-'+date+'.json';
  if(!store.claimSubmission(date,fingerprint(config),'checkin'))return reconcile(adapter,date,config,options);
  let response,postError;
  try {
    response=await adapter.submitCheckin(body);
    options.emit('submit_response',{operation:'checkin',code:response.code,ok:response.ok,
      ...(CHECKIN_AUTH_CODES.has(response.code)?{reason:'checkin_authorization_rejected'}:{})});
  }catch(e){postError=e;options.emit('submit_response_unknown',{operation:'checkin'});}
  let out=await reconcile(adapter,date,config,options);
  if(out.result==='unknown'&&(postError?.code==='need_login'||response?.code===5000))out={...out,result:'need_login'};
  else if(out.result==='unknown'&&CHECKIN_AUTH_CODES.has(response?.code)&&out.confirmedPending)out={...out,result:'need_authorization',reason:'checkin_ticket_rejected',code:response.code};
  else if(out.result==='unknown'&&response?.code===4001&&response.ok!==true&&out.confirmedPending)out={...out,result:'checkin_rejected'};
  store.write(name,{businessDate:date,kind:'checkin',fingerprint:fingerprint(config),state:out.result,
    ...(CHECKIN_AUTH_CODES.has(response?.code)?{authorizationCode:response.code}:{}),at:new Date().toISOString()});
  return out;
}
export async function runDaily({config,store,dryRun=false,now=()=>new Date(),open=launchBrowser,adapterFactory=createUestcAdapter,sleep=sleepDefault}) {
  config=validateConfig(config);
  if(!config.submissionsEnabled&&!dryRun)return {result:'submission_disabled',submitted:false};
  const unlock=store.acquire();if(!unlock)return {result:'already_running'};
  let ctx,submitted=false;
  const emit=(event,detail)=>store.log(event,detail);
  try {
    ctx=await open(config,store.dir);
    const adapter=adapterFactory(ctx,config,{store});await adapter.authenticate();
    const record=await adapter.getToday();emit('today',summary(record));
    const state=todayState(record,now());
    if(state==='unknown')return {result:'unknown',reason:'today_unavailable_or_date_changed'};
    const date=record.data.businessDate;
    if(state==='done'&&!dryRun)return {result:'already_done',...summary(record)};
    const pastCutoff=()=>now().getTime()>=Date.parse(date+'T'+config.recoveryCutoff+':00+08:00');
    if(pastCutoff())return {result:'window_missed',reason:'recovery_cutoff_reached'};
    const priorSubmission=store.read('submission-checkin-'+date+'.json');
    if(priorSubmission&&!dryRun) {
      const out=await reconcile(adapter,date,config,{sleep,emit});
      if(out.result==='unknown'&&out.confirmedPending&&CHECKIN_AUTH_CODES.has(priorSubmission.authorizationCode))
        return {...out,result:'need_authorization',reason:'checkin_ticket_rejected',code:priorSubmission.authorizationCode};
      return out;
    }
    const window=checkinWindow(await adapter.getSchedule(),date,now());
    if(window.reason==='invalid_schedule')return {result:'unknown',reason:'invalid_checkin_schedule'};
    if(window.result!=='open')return window;
    // Check before claiming today's submission: missing authorization must not burn the attempt.
    await adapter.prepareCheckinAuthorization();
    let geo;
    try {
      geo=await adapter.getLocation();
      if(!Number.isFinite(geo?.accuracy)||geo.accuracy<0||geo.accuracy>config.maxAccuracyMeters)return {result:'location_fail',reason:'accuracy_insufficient'};
    }catch(e){return {result:e.code==='need_login'?'need_login':'location_fail',reason:'location_unavailable_or_frontend_changed'};}
    if(pastCutoff())return {result:'window_missed',reason:'recovery_cutoff_reached'};
    const dorm=findDorm(geo,await adapter.getCheckinLocations());
    if(!dorm)return {result:'location_fail',reason:'outside_dormitory_range',submitted:false};
    emit('prepared',{operation:'checkin',businessDate:date,accuracyMeter:Math.round(geo.accuracy),locationProvider:config.locationProvider});
    if(dryRun)return {result:'dry_run_ready',operation:'checkin',businessDate:date,alreadyRecorded:state==='done',locationProvider:config.locationProvider};
    const address=await adapter.getAddress(geo);
    const fresh=await adapter.getToday(),freshState=todayState(fresh,now());
    if(fresh.data?.businessDate!==date)return {result:'window_missed',reason:'business_date_changed'};
    if(freshState==='done')return {result:'already_done',...summary(fresh)};
    if(freshState!=='pending')return {result:'unknown',reason:'record_changed'};
    const schedule=await adapter.getSchedule();
    const ua=await adapter.getUserAgent();
    if(pastCutoff())return {result:'window_missed',reason:'recovery_cutoff_reached'};
    const lastWindow=checkinWindow(schedule,date,now());if(lastWindow.result!=='open')return lastWindow;
    const clientTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now());
    submitted=true;
    return await submitAndVerify(adapter,date,config,store,{latitude:geo.latitude,longitude:geo.longitude,reverseGeocode:address,userAgent:ua,clientTime,accuracy:geo.accuracy},{sleep,emit});
  }catch(e){return {result:failure(e),reason:failureReason(e),submitted};}
  finally{if(ctx)await ctx.close().catch(()=>{});unlock();}
}
export async function runWithRetries(options) {
  let out;
  for(let attempt=0;attempt<3;attempt++) {
    out=await runDaily(options);
    if(out.submitted||!['unknown','already_running'].includes(out.result)||attempt===2)break;
    await (options.sleep||sleepDefault)(30000);
  }
  options.store.write('last-result.json',{at:new Date().toISOString(),...out});options.store.log('result',out);return out;
}
export async function inspect({config,store,mode='check',ticketInput,open=launchBrowser,adapterFactory=createUestcAdapter}) {
  const unlock=store.acquire();if(!unlock)return {result:'already_running'};
  let ctx;
  try {
    ctx=await open(config,store.dir);const adapter=adapterFactory(ctx,config,{store});await adapter.authenticate();
    if(mode==='session')return {result:'session_valid'};
    if(mode==='authorization')return ticketInput===undefined
      ?await adapter.prepareCheckinAuthorization():await adapter.importCheckinTicket(ticketInput);
    if(mode==='locations') {
      const r=await adapter.getCheckinLocations();
      if(!apiSucceeded(r)||!Array.isArray(r.data))return {result:'unknown',reason:'dorm_fences_unavailable'};
      return {result:'locations_read',locations:r.data};
    }
    if(mode==='preflight') {
      await adapter.prepareCheckinAuthorization();
      let geo;try {geo=await adapter.getLocation();}catch(e){return {result:e.code==='need_login'?'need_login':'location_fail',reason:'location_unavailable_or_frontend_changed'};}
      if(!Number.isFinite(geo?.accuracy)||geo.accuracy<0||geo.accuracy>config.maxAccuracyMeters)return {result:'location_fail',reason:'accuracy_insufficient'};
      if(!findDorm(geo,await adapter.getCheckinLocations()))return {result:'location_fail',reason:'outside_dormitory_range'};
      return {result:'preflight_ready',accuracyMeter:Math.round(geo.accuracy)};
    }
    const r=await adapter.getToday();if(!apiSucceeded(r)||!r.data)return {result:'unknown',reason:'today_unavailable'};
    return {result:'record_read',...summary(r)};
  }catch(e){return {result:failure(e),reason:failureReason(e)};}
  finally{if(ctx)await ctx.close().catch(()=>{});unlock();}
}
