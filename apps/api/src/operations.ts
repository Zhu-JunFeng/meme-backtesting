import {Controller,Get,Query,ServiceUnavailableException,BadRequestException} from '@nestjs/common';
import {createQueue,OperationsSampler,operationsAlerts,deadline} from '@meme/runtime';

@Controller('api/operations')
export class OperationsController {
 private queue=createQueue();
 private sampler=new OperationsSampler('api',()=>({}),async()=> (await this.queue.client as any).ping());
 private samples:any[]=[];
 private timer?:ReturnType<typeof setInterval>;private busy=false;
 onModuleInit(){this.sampler.start();this.timer=setInterval(()=>void this.refresh(),60000);void this.refresh();}
 async onModuleDestroy(){clearInterval(this.timer);await this.sampler.close();await this.queue.close();}
 private async refresh(){if(this.busy)return;this.busy=true;try{this.samples=(await this.sampler.pool.query("SELECT DISTINCT ON (source) source,sampled_at,metrics FROM operations_metric_samples ORDER BY source,sampled_at DESC")).rows;}catch{/* preserve last known worker state */}finally{this.busy=false;}}
 @Get('status') status(){const samples=this.samples.filter(s=>s.source!=='api');if(this.sampler.latest)samples.push(this.sampler.latest);return {sampledAt:this.sampler.latest?.sampled_at??null,samples,alerts:operationsAlerts(samples),refreshSeconds:60};}
 @Get('history') async history(@Query('hours') raw='24'){const hours=Number(raw);if(!Number.isFinite(hours)||hours<1||hours>168)throw new BadRequestException('历史范围为1至168小时');try{return (await deadline(this.sampler.pool.query("SELECT source,sampled_at,metrics FROM operations_metric_samples WHERE sampled_at>=now()-($1::double precision*interval '1 hour') ORDER BY sampled_at",[hours]))).rows;}catch{throw new ServiceUnavailableException('数据库不可用，历史指标暂不可查询');}}
}
