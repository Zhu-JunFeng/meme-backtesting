import {EventEmitter} from 'node:events';
import {WebSocketServer} from 'ws';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {LiveCandleAggregator} from '@meme/engine';
import {MemeMarketConnection,parseMemeTrade} from './meme-market.js';
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
 it('requires ack and filters old revisions and other projects',()=>{vi.useFakeTimers();const h=harness();h.socket.receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(h.hooks.trade).not.toHaveBeenCalled();h.ack();h.socket.receive({type:'trade',subscription_revision:0,sequence:1,trade});h.socket.receive({type:'trade',subscription_revision:1,sequence:1,trade});expect(h.hooks.trade).toHaveBeenCalledExactlyOnceWith(trade,'s');h.socket.receive({type:'trade',subscription_revision:1,sequence:2,trade:{...trade,ca:'other'}});expect(h.hooks.trade).toHaveBeenCalledTimes(1);h.client.stop();});
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
