import { listAccounts, accountDirectory } from './accounts.mjs';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { tick } from './daemon.mjs';

export async function tickAccounts({store,signal,now=()=>new Date(),tickAccount=tick}) {
  const outcomes=[];
  // Sequential contexts keep memory use bounded and never share a browser profile.
  for(const account of listAccounts(store.dir)) {
    if(signal?.aborted)break;
    let accountStore;
    try {
      accountStore=new Store(accountDirectory(store.dir,account.id));
      const config=loadConfig(accountStore.dir);
      const out=await tickAccount({config,store:accountStore,now:now()});
      outcomes.push({id:account.id,...out});
    }catch {
      const out={id:account.id,action:'account_error'};
      outcomes.push(out);
      store.log('account_tick_error',{account:account.id,reason:'configuration_or_runtime_error'});
    }
  }
  store.write('accounts-last-tick.json',{at:now().toISOString(),accounts:outcomes});
  return outcomes;
}
export async function daemonAccounts({store,signal}) {
  const unlock=store.acquire('accounts-daemon.lock');
  if(!unlock)throw new Error('多账号调度程序已经运行');
  try {
    store.log('accounts_daemon_started',{timeZone:'Asia/Shanghai'});
    while(!signal?.aborted) {
      try {await tickAccounts({store,signal});}
      catch {store.log('accounts_tick_error',{reason:'account_registry_unavailable'});}
      if(signal?.aborted)break;
      await new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
        const timer=setTimeout(finish,30000);signal?.addEventListener('abort',finish,{once:true});
      });
    }
  }finally{store.log('accounts_daemon_stopped');unlock();}
}
