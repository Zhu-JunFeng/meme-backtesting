import {describe,it,expect,vi} from 'vitest';
import {LiveController} from './live.js';
import {Client} from 'pg';
const run={id:'r',mode:'paper',initial_capital:'100',started_at:new Date(0),strategy_json:{},interval:'30s',value_type:'mcap'};
describe('capital curve read-only API',()=>{
 it.skipIf(!process.env.TEST_DATABASE_URL)('executes full-history equity sampling in PostgreSQL',async()=>{
  const client=new Client({connectionString:process.env.TEST_DATABASE_URL}),c=new LiveController();await client.connect();
  try{
   await client.query(`CREATE TEMP TABLE live_runs(id text,mode text,initial_capital numeric,started_at timestamptz,created_at timestamptz,strategy_json jsonb,interval text,value_type text);
    CREATE TEMP TABLE live_equity_curve(run_id text,time bigint,equity numeric,cash numeric,unrealized numeric);
    INSERT INTO live_runs VALUES('r','paper',100,to_timestamp(0),to_timestamp(0),'{}','30s','mcap');
    INSERT INTO live_equity_curve SELECT 'r',i,CASE WHEN i=100 THEN -100 WHEN i=3900 THEN 10000 ELSE 100 END,100,0 FROM generate_series(1,4000) i;`);
   vi.spyOn((c as any).pool,'query').mockImplementation((...args:any[])=>client.query(args[0],args[1]));
   const result=await c.capitalCurve('r',{kind:'equity'});
   expect(result.total).toBe(4000);expect(result.sampled).toBe(true);expect(result.points.length).toBeLessThanOrEqual(1800);
   expect(result.points[0].time).toBe(1);expect(result.points.at(-1)?.time).toBe(4000);
   expect(result.points.some(p=>p.equity===-100)).toBe(true);expect(result.points.some(p=>p.equity===10000)).toBe(true);
  }finally{await client.end();await c.onModuleDestroy();}
 });
 it('reuses portfolio net accounting including all fill costs',async()=>{
  const c=new LiveController();
  const fill=(side:string,time:number,gross:number)=>({id:side,position_id:'p',chain:'sol',ca:'ca',pair_id:'pair',side,reason:side==='buy'?'entry':'take_profit',decision_time:time,fill_time:time,fill_value:100,fill_price:1,market_cap:100,quantity:1,gross_amount:gross,fee:1,slippage_cost:1,tax_cost:1});
  const query=vi.spyOn((c as any).pool,'query').mockResolvedValueOnce({rows:[run]}).mockResolvedValueOnce({rows:[fill('buy',1000,10),fill('sell',2000,20)]}).mockResolvedValueOnce({rows:[]});
  try{
   const result=await c.capitalCurve('r',{});
   expect(result).toMatchObject({kind:'realized',initialCapital:100,closedCount:1,incompleteCount:0,total:2,sampled:false,lastDataTime:2000,points:[{time:0,equity:100},{time:2000,equity:104}]});
   expect(query.mock.calls.every(call=>String(call[0]).startsWith('SELECT'))).toBe(true);
  }finally{await c.onModuleDestroy();}
 });
 it('returns empty instead of fictional fills',async()=>{
  const c=new LiveController();vi.spyOn((c as any).pool,'query').mockResolvedValueOnce({rows:[run]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
  try{expect(await c.capitalCurve('r',{kind:'realized'})).toMatchObject({points:[],total:0,lastDataTime:null,closedCount:0});}finally{await c.onModuleDestroy();}
 });
 it('rejects unsupported kind, missing task, and live wallet equity',async()=>{
  const c=new LiveController();const query=vi.spyOn((c as any).pool,'query').mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{...run,mode:'live'}]});
  try{
   await expect(c.capitalCurve('r',{kind:'unknown'})).rejects.toThrow('类型无效');
   await expect(c.capitalCurve('r',{})).rejects.toThrow('任务不存在');
   await expect(c.capitalCurve('r',{kind:'equity'})).rejects.toThrow('钱包权益');
   expect(query).toHaveBeenCalledTimes(2);
  }finally{await c.onModuleDestroy();}
 });
 it('converts full-history sampled equity and exposes provenance',async()=>{
  const c=new LiveController();const query=vi.spyOn((c as any).pool,'query').mockResolvedValueOnce({rows:[run]}).mockResolvedValueOnce({rows:[{time:'123',equity:'101.25',cash:'90',unrealized:'1.25',total:'2000'}]});
  try{
   expect(await c.capitalCurve('r',{kind:'equity'})).toMatchObject({sampled:true,total:2000,lastDataTime:123,points:[{time:123,equity:101.25,cash:90,unrealized:1.25}]});
   expect(String(query.mock.calls[1][0])).not.toContain('LIMIT 1000');
  }finally{await c.onModuleDestroy();}
 });
});
