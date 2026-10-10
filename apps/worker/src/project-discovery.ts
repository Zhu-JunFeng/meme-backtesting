import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import type {Pool} from 'pg';
import {feedQuery,selectedProjectSources,SOURCE_WALLETS,type ProjectProvider,type ProjectSources} from '@meme/domain';
import type {ProjectSignal} from './live-input.js';

export type Discovery=ProjectSignal & {provider:ProjectProvider;observedAt:number;facts?:{createdAt?:number;marketCap?:number;kol?:number;dexId?:string;pairId?:string}};
const positive=(x:unknown)=>x!==null&&x!==''&&Number.isFinite(Number(x))&&Number(x)>0?Number(x):undefined;
export function feedCandidates(items:any[],now:number):Discovery[]{
 return items.filter(x=>typeof x.tokenAddress==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.tokenAddress)).map(x=>({
  provider:'xxyy',key:`xxyy:${x.tokenAddress}:${now}`,chain:'sol',ca:x.tokenAddress,source:'xxyy_completed',time:now,observedAt:now,
  facts:{createdAt:positive(x.tokenCreateTime),marketCap:positive(x.marketCapUSD),kol:x.kolNum==null||x.kolNum===''?undefined:Number(x.kolNum),dexId:x.dexId,pairId:x.pairAddress},
  identity:{source:'xxyy_completed',signalName:'XXYY 项目发现',discoveredAt:now,tokenCreateTime:x.tokenCreateTime}
 }));
}

// Exact Anchor instruction discriminators, restricted to documented swap programs.
// Unknown programs/ambiguous multi-output transactions fail closed, never infer a buy from an airdrop.
export const SWAP_PROGRAMS:Record<string,string[]>={
 '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':['buy','buy_exact_sol_in','buy_v2'],
 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':['buy','buy_exact_quote_in','sell'],
 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':['route','route_with_token_ledger','shared_accounts_route','shared_accounts_route_with_token_ledger','exact_out_route','shared_accounts_exact_out_route']
};
const quotes=new Set(['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD1HfdjVrT1cQCp1g8E4hQ']);
function decode58(text:string){let value=0n;const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';for(const c of text){const i=chars.indexOf(c);if(i<0)return Buffer.alloc(0);value=value*58n+BigInt(i);}let hex=value.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.concat([Buffer.alloc(text.match(/^1*/)?.[0].length??0),value?Buffer.from(hex,'hex'):Buffer.alloc(0)]);}
export function walletBuys(tx:any,wallet:string):string[]{
 if(!tx?.meta||tx.meta.err||!tx.blockTime)return [];
 const keys=tx.transaction?.message?.accountKeys??[];
 const owner=keys.findIndex((k:any)=>(typeof k==='string'?k:k.pubkey)===wallet);
 if(owner<0||keys[owner]?.signer!==true)return [];
 const outer=tx.transaction.message.instructions??[],inner=(tx.meta.innerInstructions??[]).flatMap((x:any)=>x.instructions??[]),instructions=[...outer,...inner];
 const swap=instructions.filter((i:any)=>{
  const names=SWAP_PROGRAMS[String(i.programId)];if(!names||typeof i.data!=='string')return false;
  const bytes=decode58(i.data).subarray(0,8);
  return names.some(n=>bytes.equals(createHash('sha256').update(`global:${n}`).digest().subarray(0,8)));
 });
 if(!swap.length)return [];
 // Limit output tokens to accounts actually passed to a recognized swap instruction.
 const accounts=new Set(swap.flatMap((i:any)=>i.accounts??[]).map(String));
 const deltas=new Map<string,bigint>(),indices=new Map<string,number[]>();
 for(const [field,sign] of [['preTokenBalances',-1n],['postTokenBalances',1n]] as const)for(const b of tx.meta[field]??[]){
  if(b.owner!==wallet||!/^\d+$/.test(b.uiTokenAmount?.amount??''))continue;
  deltas.set(b.mint,(deltas.get(b.mint)??0n)+sign*BigInt(b.uiTokenAmount.amount));indices.set(b.mint,[...(indices.get(b.mint)??[]),b.accountIndex]);
 }
 const acquired=[...deltas].filter(([mint,n])=>n>0n&&!quotes.has(mint)&&indices.get(mint)?.some(i=>accounts.has(String(keys[i]?.pubkey??keys[i]))));
 const spent=[...deltas].some(([,n])=>n<0n);
 const paidSol=Number(tx.meta.preBalances?.[owner])-Number(tx.meta.postBalances?.[owner])-Number(tx.meta.fee)>0;
 // One unambiguous net acquired token; a wallet can sell a token to buy a different token.
 return acquired.length===1&&(spent||paidSol)?[acquired[0]![0]]:[];
}

type Status={state:string;lastSuccessAt?:number;lastReceivedAt?:number;scanned:number;received:number;error?:string};
export class ProjectDiscovery {
 readonly status:Record<string,Status>={wallet:{state:'idle',scanned:0,received:0},xxyy:{state:'idle',scanned:0,received:0}};
 private runs:any[]=[];private ws?:WebSocket;private timer?:ReturnType<typeof setInterval>;private stopped=false;
 private feedBusy=false;private walletBusy=false;private inboxBusy=false;private inboxAt=0;private feedAt=0;private walletAt=0;private rpcAt=0;private rpcChain=Promise.resolve();
 private operations=new Set<Promise<unknown>>();
 constructor(private db:Pool,private deliver:(signal:Discovery)=>Promise<void>,private request:typeof fetch=fetch){}
 update(runs:any[]){this.runs=runs;const enabled=this.enabled('wallet');if(enabled&&!this.ws)this.connectWallet();if(!enabled&&this.ws){const ws=this.ws;this.ws=undefined;ws.close();}if(!this.timer)this.timer=setInterval(()=>this.tick(),1000);this.tick();}
 async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.ws?.close();await Promise.allSettled([...this.operations]);}
 private track(p:Promise<unknown>){this.operations.add(p);void p.finally(()=>this.operations.delete(p));}
 async accept(signal:Discovery){
  await this.db.query('INSERT INTO live_source_receipts(event_key,provider,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[`${signal.provider}:${signal.source}:${signal.key}`,signal.provider,JSON.stringify(signal)]);
 }
 private enabled(p:'wallet'|'xxyy'){return this.runs.some(r=>r.chain==='sol'&&selectedProjectSources(r)[p].enabled);}
 private tick(){if(this.stopped)return;const now=Date.now();
  if(this.enabled('xxyy')&&!this.feedBusy&&now>=this.feedAt){this.feedAt=now+10000;this.feedBusy=true;this.track(this.pollFeed().catch(()=>{this.status.xxyy.state='retrying';this.status.xxyy.error='XXYY 查询失败，自动重试';this.feedAt=Date.now()+30000;}).finally(()=>this.feedBusy=false));}
  if(this.enabled('wallet')&&!this.walletBusy&&now>=this.walletAt){this.walletAt=now+10000;this.walletBusy=true;this.track(this.scanWallets().catch(()=>{this.status.wallet.state='retrying';this.status.wallet.error='钱包 RPC 查询失败或交易暂不可用，游标保留并自动重试';this.walletAt=Date.now()+15000;}).finally(()=>this.walletBusy=false));}
  if(this.runs.length&&!this.inboxBusy&&now>=this.inboxAt){this.inboxAt=now+5000;this.inboxBusy=true;this.track(this.drainInbox().catch(()=>{this.inboxAt=Date.now()+15000;}).finally(()=>this.inboxBusy=false));}
 }
 private async pollFeed(){
  const key=process.env.XXYY_API_KEY;if(!key){this.status.xxyy.state='unconfigured';this.status.xxyy.error='未配置 XXYY_API_KEY';return;}
  const body=feedQuery(this.runs.filter(r=>r.chain==='sol').map(selectedProjectSources));if(!body)return;
  const r=await this.request('https://www.xxyy.io/api/trade/open/api/feed/COMPLETED?chain=sol',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error('feed HTTP');const data=await r.json() as any;
  if(data.code!==200||data.success===false||!Array.isArray(data.data?.items))throw new Error('feed response');
  if(this.stopped||!this.enabled('xxyy'))return;
  const now=Date.now();this.status.xxyy.scanned+=data.data.items.length;
  let failed=0;
  for(const signal of feedCandidates(data.data.items,now)){if(this.stopped)return;try{await this.deliver(signal);this.status.xxyy.received++;}catch{failed++;}}
  Object.assign(this.status.xxyy,{state:'connected',lastSuccessAt:now,lastReceivedAt:now,error:undefined});
  if(failed)this.status.xxyy.error=`${failed} 个项目资料或准入处理失败，下次轮询重试`;
 }
 private connectWallet(){
  if(this.stopped||!this.enabled('wallet'))return;
  const ws=new WebSocket(process.env.SOLANA_RPC_WS_URL??'wss://api.mainnet-beta.solana.com');this.ws=ws;
  ws.on('open',()=>{SOURCE_WALLETS.forEach((wallet,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'logsSubscribe',params:[{mentions:[wallet]},{commitment:'confirmed'}]})));this.status.wallet.state='connecting';});
  ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.error){this.status.wallet.error='钱包订阅失败，自动重连';ws.close();return;}if(m.method==='logsNotification'){this.status.wallet.lastReceivedAt=Date.now();this.walletAt=0;}if(typeof m.result==='number')this.status.wallet.state='connected';}catch{/* malformed message does not advance any cursor */}});
  ws.on('error',()=>{this.status.wallet.state='retrying';this.status.wallet.error='钱包 WebSocket 连接异常';});
  ws.on('close',()=>{if(this.ws===ws)this.ws=undefined;if(!this.stopped&&this.enabled('wallet'))setTimeout(()=>{if(!this.ws)this.connectWallet();},3000);});
 }
 private rpc(method:string,params:any[]):Promise<any>{
  const op=this.rpcChain.then(async()=>{const delay=this.rpcAt-Date.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));this.rpcAt=Date.now()+1100;
   const r=await this.request(process.env.SOLANA_RPC_HTTP_URL??'https://api.mainnet-beta.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw new Error('RPC HTTP');const data=await r.json() as any;if(data.error)throw new Error('RPC error');return data.result;
  });this.rpcChain=op.then(()=>undefined,()=>undefined);return op;
 }
 private async saveCursor(key:string,state:any){await this.db.query('INSERT INTO live_source_cursors(source_key,state_json) VALUES($1,$2) ON CONFLICT(source_key) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()',[key,JSON.stringify(state)]);}
 private async scanWallets(){
  let failures=0;
  for(const wallet of SOURCE_WALLETS){if(this.stopped||!this.enabled('wallet'))return;
   try{
   const key=`wallet:${wallet}`,saved=(await this.db.query('SELECT state_json FROM live_source_cursors WHERE source_key=$1',[key])).rows[0]?.state_json;
   const state=saved??{since:Date.now(),head:null,before:null,target:null,pending:[]};
   if(!saved)await this.saveCursor(key,state);
   if(!state.pending.length){
    const page=await this.rpc('getSignaturesForAddress',[wallet,{limit:100,before:state.before??undefined,commitment:'confirmed'}]);if(!Array.isArray(page))throw new Error('RPC signatures');
    if(!state.target)state.target=page[0]?.signature??state.head;
    const end=page.findIndex((x:any)=>x.signature===state.head||(x.blockTime&&x.blockTime*1000<state.since));
    state.pending=(end>=0?page.slice(0,end):page).filter((x:any)=>!x.err);
    state.finished=end>=0||page.length<100;state.before=page.at(-1)?.signature??null;
    await this.saveCursor(key,state);
   }
   // Bounded batch; retain unfinished page durably across restarts and RPC limits.
   for(let n=0;n<10&&state.pending.length;n++){
    if(this.stopped)return;const item=state.pending[0];const tx=await this.rpc('getTransaction',[item.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    if(this.stopped)return;if(!tx||tx.blockTime==null)throw new Error('RPC transaction pending');
    const now=Date.now();this.status.wallet.scanned++;
    for(const ca of walletBuys(tx,wallet)){
     const eventKey=`wallet:${wallet}:${item.signature}:${ca}`;
     const signal:Discovery={provider:'wallet',key:eventKey,chain:'sol',ca,source:'wallet_buy',time:now,observedAt:now,identity:{source:'wallet_buy',signalName:'钱包买入',wallet,signature:item.signature,transactionTime:tx.blockTime*1000,discoveredAt:now}};
     await this.accept(signal);
    }
    state.pending.shift();await this.saveCursor(key,state);
   }
   if(!state.pending.length&&state.finished){state.head=state.target;state.before=null;state.target=null;await this.saveCursor(key,state);}
   }catch{failures++;}
  }
  if(failures)throw new Error('wallet scan incomplete');
  Object.assign(this.status.wallet,{state:'connected',lastSuccessAt:Date.now(),error:undefined});
 }
 private async drainInbox(){
  const pending=(await this.db.query("SELECT event_key,provider,payload FROM live_source_receipts WHERE processed_at IS NULL AND (retry_at IS NULL OR retry_at<=now()) ORDER BY created_at LIMIT 20")).rows;
  for(const row of pending){if(this.stopped)return;
   try{await this.deliver(row.payload);await this.db.query('UPDATE live_source_receipts SET processed_at=now() WHERE event_key=$1',[row.event_key]);if(this.status[row.provider])this.status[row.provider].received++;}
   catch{await this.db.query("UPDATE live_source_receipts SET retry_at=now()+interval '30 seconds' WHERE event_key=$1",[row.event_key]);}
  }
 }
}
