import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import type {MarketTrade} from '@meme/engine';

export type Project={chain:string;ca:string};
export const projectKey=(p:Project)=>`${p.chain}:${p.ca}`;
export function parseMemeTrade(t:any):MarketTrade|undefined{
 const decimal=(v:unknown)=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)&&Number.isFinite(Number(v));
 if(!t||typeof t.chain!=='string'||typeof t.ca!=='string'||typeof t.pair_id!=='string'||!t.pair_id||typeof t.event_id!=='string'||!t.event_id.trim()||!Number.isSafeInteger(t.trade_time)||t.trade_time<0||t.trade_time>Date.now()+5000||!decimal(t.price_usd)||Number(t.price_usd)<=0||!decimal(t.volume_usd))return;
 return {id:t.event_id,chain:t.chain,ca:t.ca,pairId:t.pair_id,time:t.trade_time,price:Number(t.price_usd),volumeUsd:Number(t.volume_usd),mcap:decimal(t.market_cap_usd)&&Number(t.market_cap_usd)>0?Number(t.market_cap_usd):undefined};
}
type Hooks={ready:(projects:Project[],session:string)=>void; removed?:(projects:Project[])=>void; interrupted:(projects:Project[],reason:string)=>void; trade:(trade:any,session:string)=>void; capacity:(n:number)=>void; message:()=>void};
type Control={id:string;action:'set_subscriptions'|'subscribe'|'unsubscribe';before:Project[];after:Project[]};
const unique=(projects:Project[])=>[...new Map(projects.map(p=>[projectKey(p),p])).values()];
const difference=(a:Project[],b:Project[])=>a.filter(p=>!b.some(x=>projectKey(x)===projectKey(p)));

/** Incremental acknowledged membership; changing membership never resets a retained project's epoch. */
export class MemeMarketConnection {
 private ws?:WebSocket;private timer?:ReturnType<typeof setInterval>;private retry?:ReturnType<typeof setTimeout>;
 private stopped=false;private fatal=false;private attempt=0;private revision=-1;private sequence=0;private session='';private deadline=0;private lastMessage=0;private opened=0;
 private desired:Project[];private confirmed:Project[]=[];private pending?:Control;private buffered:any[]=[];private nextControlAt=0;private controlDelay=1000;
 constructor(projects:Project[],private readonly hooks:Hooks,private readonly url:string,private readonly factory=(url:string)=>new WebSocket(url,{maxPayload:32_768})){this.desired=unique(projects);}
 get projects(){return this.desired;}
 updateProjects(projects:Project[]){this.desired=unique(projects);this.pump();}
 start(){if(this.stopped||this.fatal||this.ws)return;this.connect();}
 stop(){this.stopped=true;this.detach();if(this.retry)clearTimeout(this.retry);this.retry=undefined;}
 private detach(){if(this.timer)clearInterval(this.timer);this.timer=undefined;const ws=this.ws;this.ws=undefined;ws?.removeAllListeners();ws?.terminate();}
 private fail(reason:string,fatal=false){if(this.stopped||!this.ws)return;this.fatal=fatal;this.hooks.interrupted(this.projects,reason);this.detach();if(!fatal)this.retry=setTimeout(()=>{this.retry=undefined;this.connect();},Math.min(30_000,1000*2**Math.min(this.attempt++,5))*(0.8+Math.random()*0.4));}
 private pump(){
  if(this.stopped||this.fatal||!this.ws||!this.session||this.pending||Date.now()<this.nextControlAt)return;
  const before=this.confirmed,removed=difference(before,this.desired),added=difference(this.desired,before);
  const action=this.revision<0?'set_subscriptions':removed.length?'unsubscribe':added.length?'subscribe':undefined;
  if(!action)return;
  const projects=action==='set_subscriptions'?this.desired:action==='unsubscribe'?removed:added;
  const after=action==='set_subscriptions'?[...this.desired]:action==='unsubscribe'?difference(before,removed):unique([...before,...added]);
  const id=randomUUID();this.pending={id,action,before:[...before],after};this.deadline=Date.now()+10_000;this.nextControlAt=Date.now()+this.controlDelay;
  this.ws.send(JSON.stringify({type:action,request_id:id,projects}));
 }
 private deliver(m:any){if(m.subscription_revision!==this.revision)return;if(!this.confirmed.some(p=>projectKey(p)===projectKey(m.trade??{}))||!this.desired.some(p=>projectKey(p)===projectKey(m.trade??{})))return;this.hooks.trade(m.trade,this.session);}
 private connect(){
  if(this.stopped||this.fatal)return;
  const ws=this.factory(this.url);this.ws=ws;this.revision=-1;this.sequence=0;this.session='';this.confirmed=[];this.pending=undefined;this.buffered=[];this.nextControlAt=0;this.deadline=Date.now()+10_000;this.lastMessage=Date.now();this.opened=Date.now();
  ws.on('error',()=>{if(this.ws===ws)this.fail('Meme Market 网络连接失败');});
  ws.on('close',()=>{if(this.ws===ws)this.fail('Meme Market 连接断开，等待重订阅和补数');});
  this.timer=setInterval(()=>{if(Date.now()>this.deadline&&(this.revision<0||this.pending))this.fail('Meme Market 握手／订阅确认超时');else if(Date.now()-this.lastMessage>60_000)this.fail('Meme Market 心跳超时');else{if(this.revision>=0&&Date.now()-this.opened>=60_000)this.attempt=0;this.pump();}},1000);
  ws.on('message',raw=>{
   if(this.ws!==ws||this.stopped)return;
   let m:any;try{m=JSON.parse(raw.toString());}catch{this.fail('Meme Market 非法 JSON');return;}
   this.lastMessage=Date.now();this.hooks.message();
   if(m.type==='ping'){if(typeof m.nonce==='string')ws.send(JSON.stringify({type:'pong',request_id:randomUUID(),nonce:m.nonce}));return;}
   if(m.type==='hello'){
    if(m.protocol_version!==2){this.fail(`Meme Market 协议不兼容：需要 2，收到 ${m.protocol_version}`,true);return;}
    if(typeof m.connection_id!=='string'||!m.connection_id.trim()){this.fail('Meme Market 会话标识无效',true);return;}
    if(!Number.isInteger(m.max_projects)||m.max_projects<1){this.fail('Meme Market 容量参数无效',true);return;}
    if(this.session){this.fail('Meme Market 重复握手');return;}
    if(this.projects.length>m.max_projects){this.hooks.capacity(m.max_projects);this.fail('Meme Market 按服务端容量重新分配连接',true);return;}
    this.controlDelay=Math.max(1000,Math.ceil(1000/Math.max(1,Number(m.limits?.control_messages_per_second)||1)));
    this.session=String(m.connection_id);this.pump();return;
   }
   if(m.type==='error'){
    if(this.revision>=0&&this.pending&&m.request_id===this.pending.id){
     this.hooks.interrupted(difference(this.pending.after,this.pending.before),`Meme Market 订阅控制失败：${String(m.code)}`);
     this.pending=undefined;this.buffered=[];this.nextControlAt=Date.now()+60_000;return;
    }
    this.fail(`Meme Market 订阅失败：${String(m.code)}`,m.retryable!==true);return;
   }
   if(m.type==='ack'){
    const pending=this.pending;if(!pending||m.request_id!==pending.id)return;
    if(m.action!==pending.action||!Number.isSafeInteger(m.subscription_revision)||m.subscription_revision<Math.max(0,this.revision)||m.project_count!==pending.after.length){this.fail('Meme Market 订阅确认内容不匹配');return;}
    if(this.revision>=0&&m.subscription_revision===this.revision&&(difference(pending.after,pending.before).length||difference(pending.before,pending.after).length)){this.fail('Meme Market 订阅版本未递增');return;}
    this.confirmed=pending.after;this.revision=m.subscription_revision;this.pending=undefined;
    const removed=difference(pending.before,pending.after),added=difference(pending.after,pending.before);
    if(removed.length)this.hooks.removed?.(removed);
    if(added.length)this.hooks.ready(added,this.session);
    const buffered=this.buffered;this.buffered=[];for(const item of buffered)this.deliver(item);this.pump();return;
   }
   if(m.type!=='trade'||!this.session)return;
   if(!Number.isSafeInteger(m.sequence)||m.sequence<1){this.fail('Meme Market 成交序号无效，暂停判断并补数');return;}
   if(m.sequence<=this.sequence)return;
   if((this.sequence>0&&m.sequence!==this.sequence+1)||(this.sequence===0&&m.sequence!==1)){this.fail('Meme Market 成交序号缺口，暂停判断并补数');return;}
   this.sequence=m.sequence;
   if(m.subscription_revision>this.revision){
    if(!this.pending){this.fail('Meme Market 未确认的订阅版本');return;}
    if(this.buffered.length>=64){this.fail('Meme Market 待确认版本成交缓冲溢出');return;}
    this.buffered.push(m);return;
   }
   this.deliver(m);
  });
 }
}

/** Sticky shard ownership: existing projects never move when another project is added/removed. */
export class MemeMarketFeed {
 private connections=new Map<number,MemeMarketConnection>();private capacity=100;private desired:Project[]=[];private nextId=0;
 lastMessageAt:number|null=null;
 constructor(private readonly hooks:Omit<Hooks,'capacity'|'message'>,private readonly url=process.env.MEME_MARKET_URL??'wss://app.memeinfo.net/api/ws/meme-market/v1',private readonly factory?:(url:string)=>WebSocket){}
 setProjects(projects:Project[]){
  this.desired=[...new Map(projects.map(p=>[projectKey(p),p])).values()].sort((a,b)=>projectKey(a).localeCompare(projectKey(b)));
  const assigned=new Set<string>();
  for(const [key,c] of this.connections){
   const kept=c.projects.filter(p=>this.desired.some(d=>projectKey(d)===projectKey(p))).slice(0,this.capacity);
   if(!kept.length){c.stop();this.connections.delete(key);this.hooks.removed?.(c.projects);continue;}
   c.updateProjects(kept);kept.forEach(p=>assigned.add(projectKey(p)));
  }
  const pending=this.desired.filter(p=>!assigned.has(projectKey(p)));
  for(const c of this.connections.values()){const added=pending.splice(0,Math.max(0,this.capacity-c.projects.length));if(added.length)c.updateProjects([...c.projects,...added]);}
  while(pending.length&&this.connections.size<10){
   const group=pending.splice(0,this.capacity),key=++this.nextId;
   const c=new MemeMarketConnection(group,{...this.hooks,message:()=>{this.lastMessageAt=Date.now();},capacity:n=>{
    this.capacity=Math.min(100,n);c.stop();this.connections.delete(key);queueMicrotask(()=>this.setProjects(this.desired));
   }},this.url,this.factory);this.connections.set(key,c);c.start();
  }
  if(pending.length)this.hooks.interrupted(pending,'Meme Market 连接容量不足，项目未就绪');
 }
 stop(){for(const c of this.connections.values())c.stop();this.connections.clear();}
 resetProjects(projects:Project[],reason:string){for(const [key,c] of this.connections)if(c.projects.some(p=>projects.some(x=>projectKey(x)===projectKey(p)))){c.stop();this.connections.delete(key);this.hooks.interrupted(c.projects,reason);}}
}
