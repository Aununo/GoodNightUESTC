#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { DEFAULTS, defaultDataDir, validateConfig, loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { launchBrowser } from '../src/browser.mjs';
import { createUestcAdapter, PORTAL } from '../src/adapters/uestc.mjs';
import { inspect, runWithRetries } from '../src/runner.mjs';
import { daemon } from '../src/daemon.mjs';
import { installService, uninstallService } from '../src/service.mjs';
import { addAccount, listAccounts, selectAccount, accountStatus } from '../src/accounts.mjs';
import { daemonAccounts } from '../src/multi-daemon.mjs';
const HELP = `GoodNight — 晚安成电自动宿舍签到
用法：node bin/goodnight.mjs <命令> [选项]
 init                  设置每日签到时间和浏览器
 login                 打开独立浏览器，首次/恢复登录由本人完成
 doctor [--online]     本地环境检查，可选业务登录检查
 check                 只读查询今日记录，不提交
 locations             只读查询学校返回的可用宿舍圈及坐标
 run [--dry-run]       只办理宿舍签到；dry-run不提交
 daemon                上海时间常驻调度（每天签到、周期会话检查）
 status                显示最近结果、预检、失败记录及会话状态
 account list          列出全部账号和各自状态
 account add <id>      新增独立账号（--label 名称，可选 --time、--browser），初始禁用提交
 service install       安装当前用户的系统服务
 service remove        卸载服务，保留配置/登录数据
 service install --write-only  只生成文件，不装载服务
 service install --server     Linux 服务器模式，使用 default.target
 service install --server --all-accounts  一个服务依次调度所有账号
全局：--data-dir <根目录> 或 GOODNIGHT_HOME；--account <id> 选择账号，默认 default
daemon、status、check 可用 --all-accounts；每个账号使用独立浏览器、配置和提交记录
init选项：--time HH:mm --browser chrome|msedge|chromium --force
桌面模式需本人已登录；Linux 服务器用 --server 并启用用户 linger。移动仓库或Node后请重新安装服务。
`;
function output(out) { console.log(JSON.stringify(out, null, 2)); }
const good = new Set(['success','already_done','dry_run_ready','record_read','locations_read','session_valid']);
function browserInstalled(c) {
  if(c.browserChannel==='chromium') return fs.existsSync(chromium.executablePath());
  const edge=c.browserChannel==='msedge', candidates=[];
  if(process.platform==='darwin') {
    const app=edge?'Microsoft Edge.app/Contents/MacOS/Microsoft Edge':'Google Chrome.app/Contents/MacOS/Google Chrome';
    candidates.push(path.join('/Applications',app),path.join(os.homedir(),'Applications',app));
  } else if(process.platform==='win32') {
    const rel=edge?'Microsoft/Edge/Application/msedge.exe':'Google/Chrome/Application/chrome.exe';
    for(const root of [process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA])if(root)candidates.push(path.join(root,rel));
  } else {
    for(const dir of (process.env.PATH||'').split(path.delimiter))for(const name of edge?['microsoft-edge','microsoft-edge-stable']:['google-chrome','google-chrome-stable'])candidates.push(path.join(dir,name));
  }
  return candidates.some(p=>fs.existsSync(p));
}
async function initialize(store,v) {
  if(fs.existsSync(store.file('config.json'))&&!v.force)throw new Error('配置已存在；需要覆盖时使用 init --force（不会删除浏览器登录态）');
  let time=v.time||DEFAULTS.reportTime,browser=v.browser||DEFAULTS.browserChannel;
  if(process.stdin.isTTY) {
    const rl=createInterface({input:process.stdin,output:process.stdout});
    try {
      time=(await rl.question('每日签到时间（上海时间，默认'+time+'）：')).trim()||time;
      browser=(await rl.question('浏览器 chrome|msedge|chromium（默认'+browser+'）：')).trim()||browser;
    }finally{rl.close();}
  }
  const config=validateConfig({...DEFAULTS,reportTime:time,browserChannel:browser});
  store.write('config.json',config);
  output({result:'configured',dataDir:store.dir,next:'login → doctor --online → run --dry-run → service install'});
}
async function login(config,store) {
  if(!process.stdin.isTTY)throw new Error('login需要本人的图形桌面与交互终端');
  const unlock=store.acquire();if(!unlock)throw new Error('浏览器正被任务使用，请暂停服务后再登录');
  let ctx,rl;
  try {
    ctx=await launchBrowser(config,store.dir,{visible:true});
    const page=ctx.pages()[0]||await ctx.newPage();await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});
    console.log('请在打开的浏览器完成统一认证，再点「晚安成电」。验证码/手机确认由本人完成。');
    rl=createInterface({input:process.stdin,output:process.stdout});await rl.question('完成后按 Enter 检查业务登录：');
    await createUestcAdapter(ctx,config,{store,allowRecovery:false}).authenticate();
    store.write('login-result.json',{at:new Date().toISOString(),result:'session_valid'});
    output({result:'session_valid'});
  }finally{rl?.close();if(ctx)await ctx.close().catch(()=>{});unlock();}
}
async function main() {
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},account:{type:'string'},'all-accounts':{type:'boolean'},label:{type:'string'},help:{type:'boolean',short:'h'},time:{type:'string'},browser:{type:'string'},force:{type:'boolean'},online:{type:'boolean'},'dry-run':{type:'boolean'},'write-only':{type:'boolean'},server:{type:'boolean'}}});
  if(v.help||!p.length){console.log(HELP);return;}
  const cmd=p[0];if(!['init','login','doctor','check','locations','run','daemon','status','service','account'].includes(cmd))throw new Error('未知命令；用 --help 查看');
  if(v.account&&v['all-accounts'])throw new Error('--account 与 --all-accounts 不能同时使用');
  if(v['all-accounts']&&!['daemon','status','check'].includes(cmd)&&!(cmd==='service'&&p[1]==='install'))throw new Error('--all-accounts 仅用于 daemon、status、check 或 service install');
  if(v.account&&['service','account'].includes(cmd))throw new Error('service 和 account 命令使用根目录；单个账号操作请使用 check/run/status 等命令');
  if(v.server && (cmd!=='service'||p[1]!=='install'||process.platform!=='linux'))throw new Error('--server 仅用于 Linux 的 service install');
  if((cmd==='service'&&(!['install','remove'].includes(p[1])||p.length!==2))||(!['service','account'].includes(cmd)&&p.length!==1))throw new Error('命令参数不正确；用 --help 查看');
  const rootDir=path.resolve(v['data-dir']||defaultDataDir());
  if(rootDir===path.parse(rootDir).root)throw new Error('数据目录不能是文件系统根目录');
  const root=new Store(rootDir);
  if(cmd==='account') {
    if(p[1]==='list'&&p.length===2)output({dataDir:rootDir,accounts:listAccounts(rootDir).map(a=>accountStatus(rootDir,a))});
    else if(p[1]==='add'&&p.length===3)output({result:'account_created',...addAccount(rootDir,p[2],{label:v.label||p[2],time:v.time,browser:v.browser}),next:`bash scripts/login-server.sh --account ${p[2]}`});
    else throw new Error('用法：account list 或 account add <id> --label 名称');
    return;
  }
  if(v['all-accounts']&&cmd==='status') {
    output({dataDir:rootDir,accounts:listAccounts(rootDir).map(a=>accountStatus(rootDir,a,{detailed:true})),lastTick:root.read('accounts-last-tick.json')});return;
  }
  if(v['all-accounts']&&cmd==='check') {
    const accounts=[];
    for(const a of listAccounts(rootDir)) {
      const selected=selectAccount(rootDir,a.id);
      try {accounts.push({...a,...await inspect({config:loadConfig(selected.dataDir),store:new Store(selected.dataDir)})});}
      catch {accounts.push({...a,result:'invalid_config'});}
    }
    output({accounts});process.exitCode=accounts.every(a=>a.result==='record_read')?0:3;return;
  }
  if(v['all-accounts']&&cmd==='daemon') {
    const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
    await daemonAccounts({store:root,signal:abort.signal});return;
  }
  const {dataDir}=selectAccount(rootDir,v.account||'default');
  const store=new Store(dataDir);
  if(cmd==='init'){await initialize(store,v);return;}
  if(cmd==='status'){output({dataDir,lastCheckin:store.read('last-result.json'),lastSession:store.read('last-session.json'),lastPreflight:store.read('last-preflight.json'),lastAuthRecovery:store.read('auth-recovery.json'),lastFailure:store.read('last-failure.json'),scheduler:store.read('scheduler.json')});return;}
  if(cmd==='service'&&p[1]==='remove') {output(await uninstallService({dataDir,apply:!v['write-only']}));return;}
  if(cmd==='doctor') {
    let config,configError;try{config=loadConfig(dataDir);}catch(e){configError=e.message;}
    const result={node:process.version,nodeSupported:Number(process.versions.node.split('.')[0])>=22,platform:process.platform,dataDir,configValid:!!config,configError,browser:config?.browserChannel,browserFound:config?browserInstalled(config):false,submissionsEnabled:config?.submissionsEnabled,locationProvider:config?.locationProvider,autoRelogin:config?.autoRelogin};
    if(v.online&&config){result.online=await inspect({config,store,mode:'session'});}
    output(result);process.exitCode=result.nodeSupported&&result.configValid&&result.browserFound&&(!v.online||result.online?.result==='session_valid')?0:3;return;
  }
  const config=loadConfig(dataDir);
  if(cmd==='service') {output(await installService({dataDir,entrypoint:fileURLToPath(import.meta.url),node:process.execPath,apply:!v['write-only'],server:!!v.server,allAccounts:!!v['all-accounts']}));return;}
  if(cmd==='login'){await login(config,store);return;}
  if(cmd==='daemon') {
    const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
    await daemon({config,store,signal:abort.signal});return;
  }
  const out=['check','locations'].includes(cmd)?await inspect({config,store,mode:cmd}):await runWithRetries({config,store,dryRun:!!v['dry-run']});
  output(out);process.exitCode=good.has(out.result)?0:3;
}
main().catch(e=>{console.error(JSON.stringify({result:'error',message:e instanceof Error?e.message:'运行失败'}));process.exitCode=3;});
