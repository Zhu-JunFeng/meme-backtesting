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
type Hooks={ready:(projects:Project[],session:string)=>void; interrupted:(projects:Project[],reason:string)=>void; trade:(trade:any,session:string)=>void; capacity:(n:number)=>void; message:()=>void};

/** One acknowledged subscription set per connection. Never interpret protocol 1 snapshots as trades. */
export class MemeMarketConnection {
 private ws?:WebSocket;private timer?:ReturnType<typeof setInterval>;private retry?:ReturnType<typeof setTimeout>;
 private stopped=false;private fatal=false;private attempt=0;private revision=-1;private sequence=0;private session='';private request='';private deadline=0;private lastMessage=0;private opened=0;
 constructor(readonly projects:Project[],private readonly hooks:Hooks,private readonly url:string,private readonly factory=(url:string)=>new WebSocket(url,{maxPayload:32_768})){}
 start(){if(this.stopped||this.fatal||this.ws)return;this.connect();}
 stop(){this.stopped=true;this.detach();if(this.retry)clearTimeout(this.retry);this.retry=undefined;}
 private detach(){if(this.timer)clearInterval(this.timer);this.timer=undefined;const ws=this.ws;this.ws=undefined;ws?.removeAllListeners();ws?.terminate();}
 private fail(reason:string,fatal=false){if(this.stopped||!this.ws)return;this.fatal=fatal;this.hooks.interrupted(this.projects,reason);this.detach();if(!fatal)this.retry=setTimeout(()=>{this.retry=undefined;this.connect();},Math.min(30_000,1000*2**Math.min(this.attempt++,5))*(0.8+Math.random()*0.4));}
 private connect(){
  if(this.stopped||this.fatal)return;
  const ws=this.factory(this.url);this.ws=ws;this.revision=-1;this.sequence=0;this.deadline=Date.now()+10_000;this.lastMessage=Date.now();this.opened=Date.now();
  ws.on('error',()=>{if(this.ws===ws)this.fail('Meme Market 网络连接失败');});
  ws.on('close',()=>{if(this.ws===ws)this.fail('Meme Market 连接断开，等待重订阅和补数');});
  this.timer=setInterval(()=>{if(Date.now()>this.deadline&&this.revision<0)this.fail('Meme Market 握手／订阅确认超时');else if(Date.now()-this.lastMessage>60_000)this.fail('Meme Market 心跳超时');else if(this.revision>=0&&Date.now()-this.opened>=60_000)this.attempt=0;},1000);
  ws.on('message',raw=>{
   if(this.ws!==ws||this.stopped)return;
   let m:any;try{m=JSON.parse(raw.toString());}catch{this.fail('Meme Market 非法 JSON');return;}
   this.lastMessage=Date.now();this.hooks.message();
   if(m.type==='ping'){if(typeof m.nonce==='string')ws.send(JSON.stringify({type:'pong',request_id:randomUUID(),nonce:m.nonce}));return;}
   if(m.type==='hello'){
    if(m.protocol_version!==2){this.fail(`Meme Market 协议不兼容：需要 2，收到 ${m.protocol_version}`,true);return;}
    if(typeof m.connection_id!=='string'||!m.connection_id.trim()){this.fail('Meme Market 会话标识无效',true);return;}
    if(!Number.isInteger(m.max_projects)||m.max_projects<1){this.fail('Meme Market 容量参数无效',true);return;}
    if(this.projects.length>m.max_projects){this.hooks.capacity(m.max_projects);this.fail('Meme Market 按服务端容量重新分配连接',true);return;}
    this.session=String(m.connection_id);this.request=randomUUID();this.deadline=Date.now()+10_000;
    ws.send(JSON.stringify({type:'set_subscriptions',request_id:this.request,projects:this.projects}));return;
   }
   if(m.type==='error'){this.fail(`Meme Market 订阅失败：${String(m.code)}`,m.retryable!==true);return;}
   if(m.type==='ack'){
    if(m.request_id!==this.request||m.action!=='set_subscriptions'||!Number.isSafeInteger(m.subscription_revision)||m.subscription_revision<0||m.project_count!==this.projects.length)return;
    if(this.revision>=0)return;this.revision=m.subscription_revision;this.hooks.ready(this.projects,this.session);return;
   }
   if(m.type!=='trade'||this.revision<0||m.subscription_revision!==this.revision)return;
   if(!Number.isSafeInteger(m.sequence)||m.sequence<1){this.fail('Meme Market 成交序号无效，暂停判断并补数');return;}
   if(m.sequence<=this.sequence)return;
   if((this.sequence>0&&m.sequence!==this.sequence+1)||(this.sequence===0&&m.sequence!==1)){this.fail('Meme Market 成交序号缺口，暂停判断并补数');return;}
   this.sequence=m.sequence;
   if(!this.projects.some(p=>p.chain===m.trade?.chain&&p.ca===m.trade?.ca))return;
   this.hooks.trade(m.trade,this.session);
  });
 }
}

/** Stable sharding; subscription changes restart only affected shards. */
export class MemeMarketFeed {
 private connections=new Map<string,MemeMarketConnection>();private capacity=100;private desired:Project[]=[];
 lastMessageAt:number|null=null;
 constructor(private readonly hooks:Omit<Hooks,'capacity'|'message'>,private readonly url=process.env.MEME_MARKET_URL??'wss://app.memeinfo.net/api/ws/meme-market/v1'){}
 setProjects(projects:Project[]){
  this.desired=[...new Map(projects.map(p=>[projectKey(p),p])).values()].sort((a,b)=>projectKey(a).localeCompare(projectKey(b)));
  const groups:Project[][]=[];for(let i=0;i<this.desired.length;i+=this.capacity)groups.push(this.desired.slice(i,i+this.capacity));
  const required=new Map(groups.slice(0,10).map(g=>[JSON.stringify(g),g]));
  for(const [key,c] of this.connections)if(!required.has(key)){c.stop();this.connections.delete(key);this.hooks.interrupted(c.projects,'订阅列表更新，等待重新确认');}
  if(groups.length>10)this.hooks.interrupted(groups.slice(10).flat(),'Meme Market 连接容量不足，项目未就绪');
  for(const [key,group] of required)if(!this.connections.has(key)){
   const c=new MemeMarketConnection(group,{...this.hooks,message:()=>{this.lastMessageAt=Date.now();},capacity:n=>{this.capacity=Math.min(100,n);queueMicrotask(()=>this.setProjects(this.desired));}},this.url);this.connections.set(key,c);c.start();
  }
 }
 stop(){for(const c of this.connections.values())c.stop();this.connections.clear();}
 resetProjects(projects:Project[],reason:string){for(const [key,c] of this.connections)if(c.projects.some(p=>projects.some(x=>projectKey(x)===projectKey(p)))){c.stop();this.connections.delete(key);this.hooks.interrupted(c.projects,reason);}}
}
