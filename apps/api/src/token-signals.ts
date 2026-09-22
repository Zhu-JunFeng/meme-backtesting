import {BadRequestException} from '@nestjs/common';
import type {Pool} from 'pg';
import type {DatasetSelection,DatasetConfig,ExternalSignal} from '@meme/domain';
import {resolveDataset,paginate} from './datasets.js';

const key=(r:{chain:string;ca:string})=>JSON.stringify([r.chain,r.ca]);
export async function readExternalSignals(pool:Pool,refs:Array<{chain:string;ca:string}>):Promise<ExternalSignal[]> {
 const unique=[...new Map(refs.map(s=>[key(s),{chain:s.chain,ca:s.ca}])).values()];
 return (await pool.query(`SELECT e.id,e.chain,e.ca,e.signal_source AS "signalSource",e.detail_id AS "detailId",e.signal_time::float8 AS "signalTime",e.source_signal AS "sourceSignal",e.provenance FROM token_signal_events e JOIN jsonb_to_recordset($1::jsonb) AS s(chain text,ca text) ON e.chain=s.chain AND e.ca=s.ca ORDER BY e.signal_time,e.id`,[JSON.stringify(unique)])).rows;
}
export async function resolveSignalDataset(pool:Pool,input:DatasetSelection,enabled:boolean):Promise<DatasetConfig> {
 if(typeof enabled!=='boolean')throw new BadRequestException('信号后买入设置必须是布尔值');
 const refs=input.cas?.length?input.cas:input.symbols;
 if(input.entrySignals!==undefined&&(!Array.isArray(input.entrySignals)||input.entrySignals.some(s=>!s||typeof s.chain!=='string'||typeof s.ca!=='string'||!Number.isSafeInteger(s.signalTime)||s.signalTime<0)))throw new BadRequestException('客户端信号格式无效');
 if(!Array.isArray(refs)||!refs.length||refs.length>10000||refs.some(s=>!s||typeof s.chain!=='string'||!s.chain.trim()||typeof s.ca!=='string'||!s.ca.trim()))throw new BadRequestException('请选择有效的 CA（最多 10000 个）');
 const normalized=refs.map(s=>({...s,chain:s.chain.trim().toLowerCase(),ca:s.chain.trim().toLowerCase()==='robin'?s.ca.trim().toLowerCase():s.ca.trim()}));
 const events=await readExternalSignals(pool,normalized);
 const earliest=new Map<string,number>();for(const e of events)earliest.set(key(e),Math.min(earliest.get(key(e))??Infinity,e.signalTime));
 // token_info is the authoritative earliest signal summary; event history is frozen separately.
 const info=(await pool.query(`SELECT t.chain,t.ca,MIN(t.signal_time)::float8 AS time FROM token_info t JOIN jsonb_to_recordset($1::jsonb) AS s(chain text,ca text) ON t.chain=s.chain AND t.ca=s.ca WHERE t.signal_time IS NOT NULL GROUP BY t.chain,t.ca`,[JSON.stringify([...new Map(normalized.map(s=>[key(s),{chain:s.chain,ca:s.ca}])).values()])])).rows;
 for(const r of info)earliest.set(key(r),Number(r.time));
 for(const s of input.entrySignals??[])if(earliest.get(key(s))!==s.signalTime)throw new BadRequestException('客户端信号时间与数据库不一致，请重新预检');
 const excluded=enabled?[...new Map(normalized.filter(s=>!earliest.has(key(s))).map(s=>[key(s),{chain:s.chain,ca:s.ca}])).values()]:[];
 const selected=normalized.filter(s=>!enabled||earliest.has(key(s)));
 if(!selected.length)throw new BadRequestException({message:'所选 CA 全部缺少有效信号时间，不能提交',excluded});
 const entrySignals=enabled?[...new Map(selected.map(s=>[key(s),{chain:s.chain,ca:s.ca,signalTime:earliest.get(key(s))!}])).values()]:undefined;
 const cleaned={...input,...(input.cas?.length?{cas:selected}:{symbols:selected as DatasetSelection['symbols']}),entrySignals};
 const result=await resolveDataset(pool,cleaned);
 const wanted=new Set(result.symbols.map(key));
 return {...result,entrySignals,selection:structuredClone(input),externalSignals:events.filter(e=>wanted.has(key(e))),signalSelection:{enabled,excluded,noOpportunity:(result.pools??[]).filter(p=>enabled&&p.endTime!==null&&earliest.get(key(p))!>=p.endTime).map(({chain,ca,pairId})=>({chain,ca,pairId}))}};
}
export async function externalSignalsForRun(pool:Pool,run:any,q:Record<string,string>){
 const c=run.config_json as DatasetConfig;
 const symbols=c.symbols.filter(s=>(!q.chain||q.chain===s.chain)&&(!q.ca||q.ca===s.ca)&&(!q.pairId||q.pairId===s.pairId));
 const wanted=new Set(symbols.map(key));let events:ExternalSignal[];
 if(c.externalSignals!==undefined)events=c.externalSignals.map(e=>({...e,basis:'snapshot'}));
 else {
  const gates=(c.entrySignals??[]).filter(e=>wanted.has(key(e))).map(e=>({...e,id:`legacy:${key(e)}`,signalSource:'历史任务入场限制',basis:'legacy_gate' as const}));
  const extra=(await readExternalSignals(pool,symbols)).filter(e=>!gates.some(g=>key(g)===key(e)&&g.signalTime===e.signalTime)).map(e=>({...e,basis:'supplemental' as const}));events=[...gates,...extra];
 }
 const all=events.filter(e=>wanted.has(key(e))).sort((a,b)=>a.signalTime-b.signalTime||a.id.localeCompare(b.id));
 const earliest=new Map<string,number>();for(const e of all)if(!earliest.has(key(e)))earliest.set(key(e),e.signalTime);
 const from=q.from===undefined?-Infinity:Number(q.from),to=q.to===undefined?Infinity:Number(q.to);
 if(Number.isNaN(from)||Number.isNaN(to)||from>to)throw new BadRequestException('外部信号查询时间无效');
 return paginate(all.filter(e=>e.signalTime>=from&&e.signalTime<=to).map(e=>({...e,first:e.signalTime===earliest.get(key(e))})),q);
}
