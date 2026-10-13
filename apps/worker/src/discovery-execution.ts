import {AsyncLocalStorage} from 'node:async_hooks';

export type ScanExecution={signal:AbortSignal;valid:()=>boolean;progress:(stage:string)=>void};
export const scanExecution=new AsyncLocalStorage<ScanExecution>();
export function assertExecution(ctx=scanExecution.getStore()){if(ctx&&!ctx.valid())throw new Error('扫描已取消或执行代次已失效');}
// The deadline covers promises that ignore AbortSignal as well as response body reads.
export async function bounded<T>(work:()=>Promise<T>,ms:number,stage:string,ctx=scanExecution.getStore()):Promise<T>{
 assertExecution(ctx);ctx?.progress(stage);
 let timer:ReturnType<typeof setTimeout>|undefined;
 let abort:()=>void=()=>{};
 try{return await Promise.race([Promise.resolve().then(()=>{assertExecution(ctx);return work();}).then(value=>{assertExecution(ctx);return value;}),new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(new Error(`${stage}超时（${ms/1000}秒）`)),ms);
  abort=()=>reject(new Error(`${stage}已取消`));ctx?.signal.addEventListener('abort',abort,{once:true});
  if(ctx?.signal.aborted)abort();
 })]);}finally{clearTimeout(timer);ctx?.signal.removeEventListener('abort',abort);}
}
