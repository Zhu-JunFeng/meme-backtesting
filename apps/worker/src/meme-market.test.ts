import {EventEmitter} from 'node:events';
import {WebSocketServer} from 'ws';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {LiveCandleAggregator} from '@meme/engine';
import {MemeMarketConnection,MemeMarketFeed,parseMemeTrade} from './meme-market.js';
const project={chain:'robin',ca:'0xabc'};
const trade={...project,pair_id:'pool',event_id:'e1',trade_time:60_000,price_usd:'2',market_cap_usd:'200',volume_usd:'10'};
class Socket extends EventEmitter {sent:any[]=[];send(s:string){this.sent.push(JSON.parse(s));}terminate(){} receive(m:any){this.emit('message',JSON.stringify(m));}}
function harness(){const socket=new Socket(),hooks={ready:vi.fn(),interrupted:vi.fn(),trade:vi.fn(),capacity:vi.fn(),message:vi.fn()};const client=new MemeMarketConnection([project],hooks,'ws://test',()=>socket as never);client.start();return {socket,hooks,client,ack(){socket.receive({type:'hello',protocol_version:2,max_projects:100,connection_id:'s'});socket.receive({type:'ack',request_id:socket.sent[0].request_id,action:'set_subscriptions',subscription_revision:1,project_count:1});}};}
afterEach(()=>vi.useRealTimers());
describe('protocol 2 connection',()=>{
 it('receives a trade through a real local protocol 2 WebSocket handshake',async()=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address() as {port:number};let client:MemeMarketConnection|undefined;
  try{await new Promise<void>((resolve,reject)=>{
   server.on('connection',socket=>{socket.send(JSON.stringify({type:'hello',protocol_version:2,max_projects:100,connection_id:'local'}));socket.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='set_subscriptions'){socket.send(JSON.stringify({type:'ack',request_id:m.request_id,action:m.type,subscription_revision:1,project_count:1}));socket.send(JSON.stringify({type:'trade',subscription_revision:1,sequence:1,trade}));}});});
   client=new MemeMarketConnection([project],{ready:()=>{},interrupted:(_,reason)=>reject(new Error(reason)),capacity:()=>{},message:()=>{},trade:(t,session)=>{try{expect(t).toEqual(trade);expect(session).toBe('local');resolve();}catch(e){reject(e);}}},`ws://127.0.0.1:${address.port}`);client.start();
  });}finally{client?.stop();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('rejects protocol 1 without falling back',()=>{vi.useFakeTimers();const h=harness();h.socket.receive({type:'hello',protocol_version:1});expect(h.hooks.interrupted).toHaveBeenCalledWith([project],expect.stringContaining('不兼容'));expect(h.socket.sent).toHaveLength(0);h.client.stop();});
 it('requires ack and filters old revisions without resetting the connection sequence',()=>{vi.useFakeTimers();const h=harness();h.socket.receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(h.hooks.trade).not.toHaveBeenCalled();h.ack();h.socket.receive({type:'trade',subscription_revision:0,sequence:1,trade});h.socket.receive({type:'trade',subscription_revision:1,sequence:2,trade});expect(h.hooks.trade).toHaveBeenCalledExactlyOnceWith(trade,'s');h.socket.receive({type:'trade',subscription_revision:1,sequence:3,trade:{...trade,ca:'other'}});expect(h.hooks.trade).toHaveBeenCalledTimes(1);h.client.stop();});
 it('responds to application heartbeat and stops on known sequence gap',()=>{vi.useFakeTimers();const h=harness();h.ack();h.socket.receive({type:'ping',nonce:'nonce'});expect(h.socket.sent.at(-1)).toMatchObject({type:'pong',nonce:'nonce'});h.socket.receive({type:'trade',subscription_revision:1,sequence:3,trade});expect(h.hooks.interrupted).toHaveBeenCalledWith([project],expect.stringContaining('缺口'));expect(h.hooks.trade).not.toHaveBeenCalled();h.client.stop();});
 it('respects advertised capacity',()=>{vi.useFakeTimers();const h=harness();h.socket.receive({type:'hello',protocol_version:2,max_projects:0});expect(h.hooks.interrupted).toHaveBeenCalled();h.client.stop();});
 it('times out without hello and ignores callbacks after stop',()=>{vi.useFakeTimers();const h=harness();vi.advanceTimersByTime(11_000);expect(h.hooks.interrupted).toHaveBeenCalled();h.client.stop();h.socket.receive({type:'hello',protocol_version:2,max_projects:100});expect(h.socket.sent).toHaveLength(0);});
 it('reconnects with the full subscription set and fences callbacks from the old socket',()=>{
  vi.useFakeTimers();const sockets:Socket[]=[],hooks={ready:vi.fn(),interrupted:vi.fn(),trade:vi.fn(),capacity:vi.fn(),message:vi.fn()};
  const client=new MemeMarketConnection([project],hooks,'ws://test',()=>{const s=new Socket();sockets.push(s);return s as never;});client.start();
  const ack=(s:Socket,session:string)=>{s.receive({type:'hello',protocol_version:2,max_projects:100,connection_id:session});s.receive({type:'ack',request_id:s.sent[0].request_id,action:'set_subscriptions',subscription_revision:1,project_count:1});};
  ack(sockets[0],'old');const stale=sockets[0].listeners('message')[0];sockets[0].emit('close');vi.advanceTimersByTime(1500);expect(sockets).toHaveLength(2);ack(sockets[1],'new');
  stale(JSON.stringify({type:'trade',subscription_revision:1,sequence:1,trade}));expect(hooks.trade).not.toHaveBeenCalled();
  sockets[1].receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(hooks.trade).toHaveBeenCalledExactlyOnceWith(trade,'new');expect(sockets[1].sent[0].projects).toEqual([project]);client.stop();
 });
 it('interrupts on a malformed sequence and on heartbeat silence',()=>{
  vi.useFakeTimers();const h=harness();h.ack();h.socket.receive({type:'trade',subscription_revision:1,sequence:null,trade});expect(h.hooks.interrupted).toHaveBeenCalledWith([project],expect.stringContaining('序号无效'));h.client.stop();
  const second=harness();second.ack();vi.advanceTimersByTime(61000);expect(second.hooks.interrupted).toHaveBeenCalledWith([project],expect.stringContaining('心跳超时'));second.client.stop();
 });
});
describe('incremental subscription lifecycle',()=>{
 it('adds/removes B while A continues, buffers the pending version and ignores stale ack',()=>{
  vi.useFakeTimers();const h=harness(),b={chain:'sol',ca:'B'};h.ack();h.hooks.ready.mockClear();
  h.client.updateProjects([project,b]);vi.advanceTimersByTime(1000);const add=h.socket.sent.at(-1);
  expect(add.type).toBe('subscribe');expect(add.projects).toEqual([b]);
  h.socket.receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(h.hooks.trade).toHaveBeenCalledTimes(1);
  h.socket.receive({type:'trade',subscription_revision:2,sequence:2,trade:{...trade,...b}});expect(h.hooks.trade).toHaveBeenCalledTimes(1);
  h.socket.receive({type:'ack',request_id:add.request_id,action:'subscribe',subscription_revision:2,project_count:2});
  expect(h.hooks.ready).toHaveBeenCalledExactlyOnceWith([b],'s');expect(h.hooks.trade).toHaveBeenCalledTimes(2);
  h.client.updateProjects([project]);vi.advanceTimersByTime(1000);const remove=h.socket.sent.at(-1);expect(remove.type).toBe('unsubscribe');
  h.socket.receive({type:'ack',request_id:remove.request_id,action:'unsubscribe',subscription_revision:3,project_count:1});
  h.socket.receive({type:'ack',request_id:add.request_id,action:'subscribe',subscription_revision:2,project_count:2});
  h.socket.receive({type:'trade',subscription_revision:2,sequence:3,trade:{...trade,...b}});
  h.socket.receive({type:'trade',subscription_revision:3,sequence:4,trade});
  expect(h.hooks.trade).toHaveBeenCalledTimes(3);expect(h.hooks.interrupted).not.toHaveBeenCalled();expect(h.hooks.ready).toHaveBeenCalledTimes(1);h.client.stop();
 });
 it('merges rapid desired changes behind one outstanding control request',()=>{
  vi.useFakeTimers();const h=harness();h.ack();const b={chain:'sol',ca:'B'},c={chain:'sol',ca:'C'};
  h.client.updateProjects([project,b]);vi.advanceTimersByTime(1000);const pending=h.socket.sent.at(-1);
  h.client.updateProjects([project,c]);h.client.updateProjects([project,c,b]);expect(h.socket.sent).toHaveLength(2);
  h.socket.receive({type:'ack',request_id:pending.request_id,action:'subscribe',subscription_revision:2,project_count:2});vi.advanceTimersByTime(1000);
  expect(h.socket.sent.at(-1).projects).toEqual([c]);expect(h.hooks.interrupted).not.toHaveBeenCalled();h.client.stop();
 });
 it('retains A on a rejected addition and retries control only after backoff',()=>{
  vi.useFakeTimers();const h=harness(),b={chain:'sol',ca:'B'};h.ack();h.client.updateProjects([project,b]);vi.advanceTimersByTime(1000);
  h.socket.receive({type:'error',request_id:h.socket.sent.at(-1).request_id,code:'capacity',retryable:false});
  expect(h.hooks.interrupted).toHaveBeenCalledExactlyOnceWith([b],expect.stringContaining('控制失败'));
  h.socket.receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(h.hooks.trade).toHaveBeenCalledOnce();vi.advanceTimersByTime(2000);expect(h.socket.sent).toHaveLength(2);h.client.stop();
 });
 it('treats acknowledgement timeout and pending-version overflow as real interruptions',()=>{
  vi.useFakeTimers();const h=harness();h.ack();h.client.updateProjects([project,{chain:'sol',ca:'B'}]);vi.advanceTimersByTime(12_000);expect(h.hooks.interrupted).toHaveBeenCalled();h.client.stop();
  const h2=harness();h2.ack();h2.client.updateProjects([project,{chain:'sol',ca:'B'}]);vi.advanceTimersByTime(1000);
  for(let i=1;i<=65;i++)h2.socket.receive({type:'trade',subscription_revision:2,sequence:i,trade});expect(h2.hooks.interrupted).toHaveBeenCalledWith(expect.anything(),expect.stringContaining('溢出'));h2.client.stop();
 });
 it('keeps existing projects in their connection across sorting and capacity boundaries',()=>{
  vi.useFakeTimers();const sockets:Socket[]=[],hooks={ready:vi.fn(),removed:vi.fn(),interrupted:vi.fn(),trade:vi.fn()};
  const feed=new MemeMarketFeed(hooks,'ws://test',()=>{const s=new Socket();sockets.push(s);return s as never;});
  const initial=Array.from({length:100},(_,i)=>({chain:'sol',ca:`B${i}`}));feed.setProjects(initial);const first=sockets[0];first.receive({type:'hello',protocol_version:2,max_projects:100,connection_id:'one'});first.receive({type:'ack',request_id:first.sent[0].request_id,action:'set_subscriptions',subscription_revision:1,project_count:100});
  feed.setProjects([{chain:'bsc',ca:'A'},...initial]);expect(sockets).toHaveLength(2);expect(first.sent).toHaveLength(1);expect(hooks.interrupted).not.toHaveBeenCalled();
  feed.setProjects(initial.slice(1));vi.advanceTimersByTime(1000);expect(sockets).toHaveLength(2);expect(first.sent.at(-1).type).toBe('unsubscribe');expect(hooks.interrupted).not.toHaveBeenCalled();feed.stop();
 });
});
describe('trade mapping and aggregation',()=>{
 it.each(['event_id','trade_time','pair_id','price_usd','volume_usd'])('rejects missing %s',key=>{expect(parseMemeTrade({...trade,[key]:null})).toBeUndefined();});
 it('keeps zero volume and does not turn null market cap into zero',()=>{expect(parseMemeTrade({...trade,volume_usd:'0',market_cap_usd:null})).toMatchObject({volumeUsd:0,mcap:undefined});});
 it('aggregates paired OHLCV and deduplicates events, not transaction hashes',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(b=>bars.push(b));
  const first=parseMemeTrade({...trade,tx_hash:'same'})!;
  a.accept(first);a.accept(first);a.accept(parseMemeTrade({...trade,event_id:'e2',tx_hash:'same',trade_time:65_000,price_usd:'3',market_cap_usd:'300'})!);a.flush(120_000);
  expect(bars).toHaveLength(4);expect(bars.find(b=>b.type==='price'&&b.interval==='1m').candle).toMatchObject({open:2,high:3,low:2,close:3,volume:20});expect(bars.find(b=>b.type==='mcap'&&b.interval==='1m').candle).toMatchObject({open:200,high:300,close:300,volume:20});
 });
});
