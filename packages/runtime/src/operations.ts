import {Pool} from 'pg';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {readFile} from 'node:fs/promises';

export async function deadline<T>(promise:Promise<T>,ms=2000):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('probe timeout')),ms);})]);}finally{clearTimeout(timer!);}}
export function operationsAlerts(samples:any[],now=Date.now()){
 const alerts:Array<{key:string;level:string;message:string}>=[];
 for(const sample of samples){const age=now-Date.parse(sample.sampled_at);if(age>180000)alerts.push({key:`${sample.source}:stale`,level:'error',message:`${sample.source} 采样超过三分钟未更新`});}
 const worker=samples.find(s=>s.source==='worker')?.metrics;
 if(!worker)alerts.push({key:'worker:missing',level:'warning',message:'尚未取得 Worker 采样'});
 for(const [key,s] of Object.entries(worker?.discovery??{}) as any){if(['stalled','retrying'].includes(s.state))alerts.push({key:`scan:${key}`,level:s.state==='stalled'?'error':'warning',message:s.error??`${key} 扫描异常`});}
 const api=samples.find(s=>s.source==='api')?.metrics;
 for(const key of ['database','redis'])if(api?.[key]?.state==='error')alerts.push({key,level:'error',message:`${key==='database'?'数据库':'Redis'} 连接探测失败`});
 const host=api?.host;
 if(!host||now-(host.sampledAt??0)>180000)alerts.push({key:'host:stale',level:'warning',message:'服务器指标不可用或超过三分钟未更新'});
 for(const key of ['diskPercent','inodePercent'])if(host?.[key]>=85)alerts.push({key,level:host[key]>=95?'error':'warning',message:`${key==='diskPercent'?'磁盘':'inode'} 使用率 ${host[key].toFixed(2)}%`});
 if(api?.resourcePressure>=3)alerts.push({key:'host:pressure',level:'warning',message:'服务器 CPU 或内存压力持续三次采样'});
 for(const s of worker?.connections??[])if(s.enabled&&s.state!=='connected'&&now-s.disconnectedAt>60000)alerts.push({key:`ws:${s.name}`,level:'error',message:`${s.name} 断开超过一分钟`});
 return alerts;
}

export class OperationsSampler {
 readonly pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:2000,statement_timeout:2000,query_timeout:2000});
 readonly delay=monitorEventLoopDelay({resolution:100});
 latest:any;private timer?:ReturnType<typeof setInterval>;private busy=false;private lastCleanup=0;private pressure=0;
 constructor(readonly source:'api'|'worker',private snapshot:()=>any,private redisPing?:()=>Promise<unknown>){}
 start(){this.delay.enable();this.timer=setInterval(()=>void this.sample(),60000);void this.sample();}
 async close(){clearInterval(this.timer);this.delay.disable();await this.pool.end();}
 async sample(){if(this.busy)return;this.busy=true;try{
  const metrics:any={...this.snapshot(),uptime:process.uptime(),rss:process.memoryUsage().rss,eventLoopMeanMs:Number.isFinite(this.delay.mean)?this.delay.mean/1e6:0,eventLoopMaxMs:this.delay.max/1e6};this.delay.reset();
  const start=Date.now();try{await this.pool.query('SELECT 1');metrics.database={state:'connected',latencyMs:Date.now()-start};}catch{metrics.database={state:'error'};}
  if(this.source==='api'){
   const start=Date.now();try{await deadline(this.redisPing!());metrics.redis={state:'connected',latencyMs:Date.now()-start};}catch{metrics.redis={state:'error'};}
   try{metrics.host=JSON.parse(await readFile(process.env.OPERATIONS_HOST_FILE??'/run/meme-operations/host.json','utf8'));}catch{metrics.host=null;}
   this.pressure=metrics.host&&(metrics.host.cpuPercent>85||metrics.host.availableMemoryPercent<15)?this.pressure+1:0;metrics.resourcePressure=this.pressure;
  }
  this.latest={source:this.source,sampled_at:new Date().toISOString(),metrics};
  if(metrics.database.state==='connected'){await this.pool.query('INSERT INTO operations_metric_samples(source,metrics) VALUES($1,$2)',[this.source,metrics]);
   if(this.source==='api'&&Date.now()-this.lastCleanup>86400000){for(let batch=0;batch<5;batch++){const result=await this.pool.query("DELETE FROM operations_metric_samples WHERE id IN (SELECT id FROM operations_metric_samples WHERE sampled_at<now()-interval '7 days' ORDER BY sampled_at LIMIT 5000)");if((result.rowCount??0)<5000){this.lastCleanup=Date.now();break;}}}}
 }catch{console.warn('operations sampling failed',this.source);}finally{this.busy=false;}}
}
