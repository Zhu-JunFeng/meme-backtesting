// Read-only production source; all writes are confined to an explicitly named local test database.
import {Pool} from 'pg';
import {executeRun,queuePrefix,RUNTIME_VERSION} from '../dist/index.js';
import {validCandle,intervalMs,poolKey} from '@meme/engine';
const target=new URL(process.env.TEST_DATABASE_URL || '');
if(!['127.0.0.1','localhost'].includes(target.hostname) || !target.pathname.includes('test'))throw Error('Benchmark target must be a local test database');
const source=new Pool({connectionString:process.env.SOURCE_DATABASE_URL,max:4,options:'-c default_transaction_read_only=on'}),local=new Pool({connectionString:target.toString()});
const started=performance.now();let peak=0;const memory=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},100);
try{
 const run=(await source.query('SELECT config_json FROM backtest_runs WHERE id=$1',[process.argv[2]])).rows[0];if(!run)throw Error('Source run not found');const config=run.config_json;
 const id=(await local.query("INSERT INTO backtest_runs(name,status,config_json,runtime_version,queue_scope,phase) VALUES('390 CA benchmark','pending',$1,$2,$3,'freezing') RETURNING id",[JSON.stringify(config),RUNTIME_VERSION,queuePrefix()])).rows[0].id;
 let next=0,done=0,actual=0,theoretical=0;
 await Promise.all(Array.from({length:4},async()=>{for(;;){const index=next++;if(index>=config.symbols.length)return;const s=config.symbols[index],key=poolKey(s),snap=config.pools.find(p=>poolKey(p)===key);const c=await source.connect();let chunk=0,count=0,invalid=0,normalized=0,previous;
 try{await c.query('BEGIN READ ONLY');await c.query('DECLARE snapshot_source NO SCROLL CURSOR FOR SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time BETWEEN $6 AND $7 ORDER BY open_time',[s.chain,s.ca,s.pairId,config.interval,config.valueType,snap?.startTime??0,snap?.endTime??0]);
 for(;;){const r=await c.query('FETCH 4096 FROM snapshot_source');if(!r.rowCount)break;const bars=[];for(const raw of r.rows){const b=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,Number(v)]));if(!validCandle(b)){invalid++;continue;}b.closeTime ||= b.time+intervalMs(config.interval);b.valid=true;bars.push(b);count++;normalized+=previous===undefined?1:Math.max(1,Math.ceil((b.time-previous)/intervalMs(config.interval)));previous=b.time;}
 for(let offset=0;offset<bars.length;offset+=256)await local.query('INSERT INTO backtest_input_chunks VALUES($1,$2,$3,$4)',[id,key,chunk++,JSON.stringify(bars.slice(offset,offset+256))]);}
 await c.query('COMMIT');await local.query('INSERT INTO backtest_input_pools VALUES($1,$2,$3,$4,$5,$6,$7)',[id,key,JSON.stringify(s),chunk,count,normalized,invalid]);
 }finally{c.release();}done++;actual+=count;theoretical+=normalized;if(done%25===0)console.log(JSON.stringify({phase:'copy-readonly-source',pools:done,total:config.symbols.length,actual,theoretical}));
 }}));
 await local.query("UPDATE backtest_runs SET input_ready=true,phase='computing' WHERE id=$1",[id]);const computeStart=performance.now();
 console.log(JSON.stringify({id,sourceSeconds:(computeStart-started)/1000,actual,theoretical}));
 await executeRun(local,id,()=>false);
 const report=(await local.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[id])).rows[0]?.report_json;
 console.log(JSON.stringify({id,computeAndSaveSeconds:(performance.now()-computeStart)/1000,elapsedSeconds:(performance.now()-started)/1000,peakRssMiB:Math.max(peak,process.memoryUsage().rss)/1048576,actual,theoretical,report:report?{totalTrades:report.totalTrades,netPnl:report.netPnl,engineVersion:report.engineVersion}:null}));
}finally{clearInterval(memory);await source.end();await local.end();}
