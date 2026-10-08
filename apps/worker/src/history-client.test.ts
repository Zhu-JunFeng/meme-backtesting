import {describe,it,expect,vi} from 'vitest';
import {HistoryClient,parseHistory,type HistoryRequest} from './history-client.js';
const request:HistoryRequest={chain:'sol',pair:'CaseSensitivePool',interval:'1m',type:'mcap',from:60_000,to:180_000};
const row={start_time:60_000,open:'1.000000000000000000001',high:'2',low:'1',close:'1.5',volume:'0'};
const envelope=(items:any[]=[row],r=request)=>({success:true,code:'200',traceId:'trace',data:{chain:r.chain,pair_address:r.pair,interval:r.interval,value_type:r.type==='mcap'?'market_cap':'price',items}});
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
describe('MemeInfo history contract',()=>{
 it('preserves decimals, filters bounds/open candles, orders and deduplicates',()=>{
  const rows=parseHistory(envelope([{...row,start_time:120_000},row,{...row,start_time:180_000},{...row,start_time:240_000},row]),request,'endpoint').rows;
  expect(rows.map(r=>r.time)).toEqual([60_000,120_000]);expect(rows[0].open).toBe(row.open);
 });
 it('allows an empty successful result without pretending to cover the range',()=>expect(parseHistory(envelope([]),request,'url').rows).toEqual([]));
 it.each([0,200,'0'])('rejects non-contract success code %s',code=>expect(()=>parseHistory({...envelope(),code},request,'url')).toThrow());
 it.each(['chain','pair_address','interval','value_type'])('rejects a mismatched %s',field=>{const data=envelope();(data.data as any)[field]='wrong';expect(()=>parseHistory(data,request,'url')).toThrow('不匹配');});
 it.each([{open:null},{high:'NaN'},{low:'3'},{close:'0'},{volume:'-1'},{start_time:60_001},{high:'1e999'},{volume:''},{start_time:null}])('discards invalid candles and retains subsequent valid rows %o',change=>{
  const result=parseHistory(envelope([{...row,...change},{...row,start_time:120000}]),request,'url');
  expect(result.rows.map(r=>r.time)).toEqual([120000]);expect(result.quality?.discarded).toBe(1);expect(result.quality?.samples).toHaveLength(1);
 });
 it('discards every conflicting copy without choosing an arbitrary value',()=>{
  const items=[row,row,{...row,close:'1.6'},row,{...row,start_time:120000}];
  for(const input of [items,[...items].reverse()]){
   const result=parseHistory(envelope(input),request,'url');expect(result.rows.map(r=>r.time)).toEqual([120000]);expect(result.quality?.discarded).toBe(4);
  }
 });
 it('retains valid neighbours of the production malformed open/high candle in both intervals and dimensions',()=>{
  for(const interval of ['30s','1m'] as const)for(const type of ['price','mcap'] as const){
   const step=interval==='30s'?30000:60000,r={...request,interval,type,to:60000+3*step};
   const result=parseHistory(envelope([row,{...row,start_time:60000+step,open:'702624.8259',high:'599601.3927',low:'599601.3927',close:'599601.3927'},{...row,start_time:60000+2*step}],r),r,'url');
   expect(result.rows.map(r=>r.time)).toEqual([60000,60000+2*step]);expect(result.quality?.reasons).toEqual({'历史 K 线 OHLC 关系非法':1});
  }
 });
 it('bounds diagnostics and returns no usable data when all rows are invalid',()=>{
  const result=parseHistory(envelope([null,...Array.from({length:100},()=>({...row,close:'0'}))]),request,'url');
  expect(result.rows).toEqual([]);expect(result.quality?.discarded).toBe(101);expect(result.quality?.samples).toHaveLength(10);
 });
 it('does not retry a successful response containing discarded candles',async()=>{
  const fetcher=vi.fn(async()=>json(envelope([{...row,low:'3'},{...row,start_time:120000}])));
  const result=await new HistoryClient('url',fetcher as never).get(request);expect(result.rows).toHaveLength(1);expect(fetcher).toHaveBeenCalledOnce();
 });
 it('maps exactly seven fields for both resolutions and dimensions',async()=>{
  for(const interval of ['30s','1m'] as const)for(const type of ['price','mcap'] as const){
   const r={...request,interval,type};const fetcher=vi.fn(async(_url:any,_init:any)=>json(envelope([],r)));const client=new HistoryClient('https://history',fetcher as never);
   await client.get(r);expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({chain:'sol',pair_address:request.pair,interval,value_type:type==='mcap'?'market_cap':'price',from_time:60000,to_time:180000,count_back:interval==='30s'?4:2});
  }
 });
 it('retries transient errors three times, preserving error code and trace',async()=>{
  const fetcher=vi.fn(async()=>json({success:false,code:'8611',message:'upstream unavailable',traceId:'t'},502)),delay=vi.fn(async()=>{});
  await expect(new HistoryClient('url',fetcher as never,delay).get(request)).rejects.toThrow('HTTP 502 · code 8611 · traceId t');expect(fetcher).toHaveBeenCalledTimes(3);expect(delay.mock.calls).toEqual([[1000],[3000]]);
 });
 it('does not retry parameter errors or treat HTML as candles',async()=>{
  const f=vi.fn(async()=>json({code:'8609',message:'bad parameter'},400));await expect(new HistoryClient('url',f as never).get(request)).rejects.toThrow('8609');expect(f).toHaveBeenCalledOnce();
  await expect(new HistoryClient('url',async()=>new Response('challenge',{status:403})).get(request)).rejects.toThrow('非 JSON');
 });
 it('single-flights identical windows and allows only two requests at once',async()=>{
  let active=0,max=0;const releases:Array<()=>void>=[];
  const f=vi.fn(async(_url:any,init:any)=>{active++;max=Math.max(active,max);await new Promise<void>(r=>releases.push(r));active--;const b=JSON.parse(init.body);return json({success:true,code:'200',data:{...envelope([]).data,pair_address:b.pair_address}});});
  const client=new HistoryClient('url',f as never);const one=client.get(request),duplicate=client.get(request),two=client.get({...request,pair:'p2'}),three=client.get({...request,pair:'p3'});
  expect(one).toBe(duplicate);expect(f).toHaveBeenCalledTimes(2);releases.shift()!();await vi.waitFor(()=>expect(f).toHaveBeenCalledTimes(3));while(releases.length)releases.shift()!();await Promise.all([one,two,three]);expect(max).toBe(2);
 });
});
