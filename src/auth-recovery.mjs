const SCHOOL_ORIGIN='https://jzsz.uestc.edu.cn';
const IDAS_ORIGIN='https://idas.uestc.edu.cn';
const PORTAL=SCHOOL_ORIGIN+'/#/hall/home';
const BUSINESS_PAGE=SCHOOL_ORIGIN+'/daily-checkin-h5/index.html?appId=294#/pages/student/report-today/home/index';
const BUSINESS_LOGIN=SCHOOL_ORIGIN+'/daily-checkin/checkLogin';
const RECOVERY_FILE='auth-recovery.json';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timestamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;

// Prefer native autofill; use only the explicitly authorized school vault entry otherwise.
export async function recoverSchoolSession(ctx,{verify,store,now=()=>new Date(),sleep=delay,readLogin=()=>readSavedSchoolLogin(store.dir)}={}) {
  const prior=store.read(RECOVERY_FILE,{});
  const manual=store.read('login-result.json',{});
  if(['attempting','manual_required'].includes(prior.state)
      &&timestamp(manual.at)<=timestamp(prior.at))return false;
  if(prior.state==='success'&&now().getTime()-timestamp(prior.at)<600000)return false;
  const at=now().toISOString();
  store.write(RECOVERY_FILE,{at,state:'attempting'});
  store.log('auth_recovery_started');
  let page;
  const fail=reason=>{const error=new Error(reason);error.recoveryReason=reason;throw error;};
  const trusted=()=>{
    const url=new URL(page.url());
    if(![SCHOOL_ORIGIN,IDAS_ORIGIN].includes(url.origin)||url.username||url.password)fail('unexpected_login_origin');
    return url;
  };
  const verifyBusiness=async()=>{
    for(let attempt=0;attempt<3;attempt++) {
      try {await verify();return true;}catch{}
      if(attempt<2)await sleep(1000);
    }
    return false;
  };
  const success=()=>{
    store.write(RECOVERY_FILE,{at,state:'success',verifiedAt:now().toISOString()});
    store.log('auth_recovery_succeeded');
    return true;
  };
  try {
    page=await ctx.newPage();
    await page.bringToFront();
    await page.route('**/daily-checkin/api/student-checkin-record/**',route=>
      route.request().method()==='POST'?route.abort():route.continue());
    await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});
    let url=trusted();
    if(url.origin===IDAS_ORIGIN) {
      if(url.pathname!=='/authserver/login')fail('interactive_verification_required');
      const form=page.locator('form#pwdFromId:visible');
      await form.waitFor({state:'visible',timeout:10000});
      if(await form.count()!==1)fail('login_form_changed');
      const username=form.locator('input#username');
      if(await username.count()!==1)fail('login_form_changed');
      await username.click();await page.keyboard.press('Tab');
      let fields;
      for(let attempt=0;attempt<10;attempt++) {
        await sleep(500);trusted();
        fields=await form.evaluate(form=>({
        usernamePrefilled:!!form.querySelector('input#username')?.value,
        passwordPrefilled:!!form.querySelector('input#password')?.value,
        challengeVisible:[...form.querySelectorAll('input')].some(input=>
          /captcha|dynamicCode|otp/i.test(input.id+' '+input.name)&&!!(input.offsetWidth||input.offsetHeight)),
        actionOrigin:new URL(form.action,location.href).origin,
        }));
        if(fields.challengeVisible||(fields.usernamePrefilled&&fields.passwordPrefilled))break;
      }
      store.log('auth_recovery_autofill',{usernamePrefilled:fields.usernamePrefilled,passwordPrefilled:fields.passwordPrefilled,challengeVisible:fields.challengeVisible});
      if(fields.actionOrigin!==IDAS_ORIGIN)fail('unexpected_login_origin');
      if(fields.challengeVisible)fail('interactive_verification_required');
      if(!fields.usernamePrefilled||!fields.passwordPrefilled) {
        const login=await readLogin();
        if(!login)fail('saved_password_unavailable');
        trusted();
        try {
          await username.fill(login.username);
          await form.locator('input#password').fill(login.password);
          await page.keyboard.press('Tab');await sleep(1000);trusted();
        }finally{login.username='';login.password='';}
        const challenge=await form.evaluate(form=>[...form.querySelectorAll('input')].some(input=>
          /captcha|dynamicCode|otp/i.test(input.id+' '+input.name)&&!!(input.offsetWidth||input.offsetHeight)));
        if(challenge)fail('interactive_verification_required');
        store.log('auth_recovery_saved_login_used');
      }
      const submit=form.locator('#login_submit:visible');
      if(await submit.count()!==1)fail('login_form_changed');
      // One normal website login action. No retries after an uncertain/failed submission.
      await submit.click();
      for(let attempt=0;attempt<15;attempt++) {
        url=trusted();
        if(url.origin===SCHOOL_ORIGIN)break;
        await sleep(1000);
      }
      if(trusted().origin!==SCHOOL_ORIGIN)fail('login_not_confirmed');
    }
    // The registered application entry creates the business session; the H5 URL alone does not.
    await page.goto(BUSINESS_LOGIN,{waitUntil:'domcontentloaded',timeout:45000});
    trusted();
    await page.goto(BUSINESS_PAGE,{waitUntil:'domcontentloaded',timeout:45000});
    if(trusted().origin!==SCHOOL_ORIGIN)fail('interactive_verification_required');
    if(!await verifyBusiness())fail('business_session_not_confirmed');
    return success();
  }catch(error){
    const reason=error.recoveryReason||'navigation_or_auth_failed';
    store.write(RECOVERY_FILE,{at,state:'manual_required',reason});
    store.log('auth_recovery_manual_required',{reason});
    return false;
  }finally{
    if(page)await page.close().catch(()=>{});
  }
}
import { readSavedSchoolLogin } from './saved-school-login.mjs';
