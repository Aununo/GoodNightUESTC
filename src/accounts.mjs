import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULTS, loadConfig, validateConfig } from './config.mjs';
import { Store } from './store.mjs';

const DEFAULT_ACCOUNT = Object.freeze({id:'default',label:'原账号'});
const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const settingKeys = ['reportTime','recoveryCutoff','browserChannel','headless','notifications',
  'sessionIntervalMinutes','catchUpMinutes','preflightLeadMinutes','recoveryIntervalMinutes','maxAccuracyMeters'];
function failure(code) {const e=new Error(code);e.code=code;return e;}
export function validateAccountId(id) {
  if(typeof id!=='string'||!ID.test(id))throw failure('invalid_account_id');
  return id;
}
function validateLabel(label) {
  if(typeof label!=='string'||!label.trim()||label.trim().length>80||/[\0\r\n]/.test(label))throw failure('invalid_account_label');
  return label.trim();
}
export function listAccounts(rootDir) {
  const registry=new Store(rootDir).read('accounts.json');
  if(registry===null)return [{...DEFAULT_ACCOUNT}];
  if(registry?.version!==1||!Array.isArray(registry.accounts)||!registry.accounts.length)throw failure('invalid_account_registry');
  const ids=new Set();
  const entries=registry.accounts.map(entry=>{
    if(!entry||typeof entry!=='object'||Object.keys(entry).some(k=>!['id','label'].includes(k)))throw failure('invalid_account_registry');
    const id=validateAccountId(entry.id),label=validateLabel(entry.label);
    if(ids.has(id))throw failure('duplicate_account_id');
    ids.add(id);return {id,label};
  });
  if(!ids.has('default'))throw failure('default_account_missing');
  return entries;
}
// The original account keeps its original path, cookies and submission journals.
export function accountDirectory(rootDir,id) {
  validateAccountId(id);
  const root=path.resolve(rootDir);
  if(id==='default')return root;
  for(const p of [path.join(root,'accounts'),path.join(root,'accounts',id)]) {
    try {if(fs.lstatSync(p).isSymbolicLink())throw failure('account_directory_symlink');}
    catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  return path.join(root,'accounts',id);
}
export function selectAccount(rootDir,id='default') {
  validateAccountId(id);
  const account=listAccounts(rootDir).find(a=>a.id===id);
  if(!account)throw failure('account_not_found');
  return {...account,dataDir:accountDirectory(rootDir,id)};
}
export function addAccount(rootDir,id,{label=id,time,browser}={}) {
  validateAccountId(id);label=validateLabel(label);
  const root=new Store(rootDir),unlock=root.acquire('accounts.lock');
  if(!unlock)throw failure('account_registry_busy');
  try {
    const accounts=listAccounts(root.dir);
    if(accounts.some(a=>a.id===id))throw failure('account_already_exists');
    const dataDir=accountDirectory(root.dir,id);
    if(fs.existsSync(dataDir))throw failure('account_directory_exists');
    const parent=loadConfig(root.dir);
    const shared=Object.fromEntries(settingKeys.map(k=>[k,parent[k]]));
    const config=validateConfig({...DEFAULTS,...shared,
      ...(time?{reportTime:time}:{}),...(browser?{browserChannel:browser}:{}),
      submissionsEnabled:false,autoRelogin:false,locationProvider:'browser',fixedLocation:null});
    fs.mkdirSync(path.join(root.dir,'accounts'),{recursive:true,mode:0o700});
    const store=new Store(dataDir);
    store.write('config.json',config);
    store.write('account.json',{version:1,id,rootDir:root.dir});
    if(!root.read('account.json'))root.write('account.json',{version:1,id:'default',rootDir:root.dir});
    root.write('accounts.json',{version:1,accounts:[...accounts,{id,label}]});
    return {id,label,dataDir,reportTime:config.reportTime,submissionsEnabled:false};
  }finally{unlock();}
}
export function accountStatus(rootDir,account,{detailed=false}={}) {
  const dataDir=accountDirectory(rootDir,account.id),store=new Store(dataDir);
  let config;
  try {config=loadConfig(dataDir);}
  catch {return {...account,dataDir,result:'invalid_config'};}
  const result={...account,dataDir,reportTime:config.reportTime,submissionsEnabled:config.submissionsEnabled,
    locationProvider:config.locationProvider,autoRelogin:config.autoRelogin,
    identityBound:!!store.read('identity.json'),lastCheckin:store.read('last-result.json')};
  if(detailed)Object.assign(result,{lastSession:store.read('last-session.json'),lastPreflight:store.read('last-preflight.json'),
    lastAuthRecovery:store.read('auth-recovery.json'),lastFailure:store.read('last-failure.json'),scheduler:store.read('scheduler.json')});
  return result;
}
// Bind each directory to one school identity without storing names, tokens or student numbers.
export function bindAccountIdentity(store,userData) {
  const metadata=store.read('account.json');
  if(!metadata)return; // Backward-compatible single-account data directory.
  if(metadata.version!==1||typeof metadata.rootDir!=='string')throw failure('invalid_account_metadata');
  const selected=selectAccount(metadata.rootDir,metadata.id);
  if(selected.dataDir!==store.dir)throw failure('invalid_account_metadata');
  if(typeof userData?.id!=='string'||!userData.id.trim())throw failure('school_identity_unavailable');
  const hash=crypto.createHash('sha256').update('uestc-user:'+userData.id).digest('hex');
  const root=new Store(metadata.rootDir),unlock=root.acquire('identities.lock');
  if(!unlock)throw failure('account_identity_busy');
  try {
    const bound=store.read('identity.json');
    if(bound&&bound.hash!==hash)throw failure('account_identity_mismatch');
    for(const account of listAccounts(root.dir)) {
      if(account.id===metadata.id)continue;
      const other=new Store(accountDirectory(root.dir,account.id)).read('identity.json');
      if(other?.hash===hash)throw failure('school_identity_already_registered');
    }
    if(!bound)store.write('identity.json',{version:1,hash,boundAt:new Date().toISOString()});
  }finally{unlock();}
}
