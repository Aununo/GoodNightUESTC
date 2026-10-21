#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDataDir, loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { launchBrowser } from '../src/browser.mjs';
import { createUestcAdapter, PORTAL } from '../src/adapters/uestc.mjs';
import { selectAccount } from '../src/accounts.mjs';

// Temporary GUI for the owner to enter credentials. Nothing listens publicly.
async function main() {
  const {values}=parseArgs({options:{'data-dir':{type:'string'},account:{type:'string'}}});
  const selected=selectAccount(values['data-dir']||defaultDataDir(),values.account||'default');
  const store=new Store(selected.dataDir);
  const config=loadConfig(store.dir);
  if(!process.env.DISPLAY)throw new Error('请通过 bash scripts/login-server.sh 启动');
  const unlock=store.acquire();
  if(!unlock)throw new Error('浏览器正在使用中，请稍后重试');
  const stop=new AbortController(),children=[];
  const abort=()=>stop.abort();
  process.once('SIGTERM',abort);process.once('SIGINT',abort);
  const timer=setTimeout(abort,30*60*1000);
  let ctx,finished=false;
  let rejectServer;
  const serverFailed=new Promise((_,reject)=>{rejectServer=reject;});
  serverFailed.catch(()=>{});
  function child(file,args) {
    const proc=spawn(file,args,{stdio:['ignore','ignore','pipe']});
    // Do not log browser traffic, keyboard input, or credentials.
    proc.stderr.resume();
    proc.on('error',()=>rejectServer(new Error(file+' 启动失败')));
    proc.on('exit',code=>{if(!finished)rejectServer(new Error(file+' 意外退出：'+code));});
    children.push(proc);
  }
  try {
    child('x11vnc',['-display',process.env.DISPLAY,'-localhost','-rfbport','5901','-forever','-shared','-nopw','-quiet']);
    child('websockify',['--web=/usr/share/novnc','127.0.0.1:6081','127.0.0.1:5901']);
    ctx=await launchBrowser(config,store.dir,{visible:true});
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});
    console.log(`当前登录账号：${selected.label}（${selected.id}）`);
    console.log('通过 SSH 转发打开 http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale');
    console.log('请本人完成统一认证，再点“晚安成电”。本界面只登录，不提交签到或报告；30 分钟后自动关闭。');
    const adapter=createUestcAdapter(ctx,config,{store,allowRecovery:false});
    await Promise.race([serverFailed,(async()=>{
      while(!stop.signal.aborted) {
        try {
          await adapter.authenticate();
          try {
            const locations=await adapter.getCheckinLocations();
            if(locations.code===0&&Array.isArray(locations.data))store.write('available-locations.json',locations.data);
          }catch{}
          store.write('login-result.json',{at:new Date().toISOString(),result:'session_valid'});
          console.log('session_valid：登录成功，登录界面即将关闭。');
          return;
        }catch(error){
          if(['account_identity_mismatch','school_identity_already_registered','school_identity_unavailable'].includes(error.code))throw error;
        }
        await delay(5000,undefined,{signal:stop.signal});
      }
      throw new Error('登录界面已关闭或超时');
    })()]);
  }finally{
    finished=true;stop.abort();clearTimeout(timer);
    for(const proc of children)proc.kill('SIGTERM');
    if(ctx)await ctx.close().catch(()=>{});
    process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);
    unlock();
  }
}
main().catch(error=>{console.error(error.name==='AbortError'?'登录界面已关闭或超时':error.message);process.exitCode=3;});
