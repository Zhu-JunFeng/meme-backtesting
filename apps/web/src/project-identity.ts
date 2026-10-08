import {reactive,ref} from 'vue';
export type ProjectRef={chain:string;ca:string};
export type ProjectIdentity=ProjectRef&{symbol:string|null;logoUrl:string|null};
export type IdentityEntry={status:'loading'|'ready'|'missing'|'error';symbol:string|null;logoUrl:string|null};
export const normalizedProject=(p:ProjectRef):ProjectRef=>({chain:p.chain.trim().toLowerCase(),ca:p.chain.trim().toLowerCase()==='sol'?p.ca.trim():p.ca.trim().toLowerCase()});
export const projectKey=(p:ProjectRef)=>{const n=normalizedProject(p);return `${n.chain}:${n.ca}`;};
export const shortCa=(ca:string)=>ca.length>12?`${ca.slice(0,6)}…${ca.slice(-4)}`:ca;
export function safeLogo(value:unknown):string|null{
 if(typeof value!=='string'||!value.trim())return null;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
type Transport=(projects:ProjectRef[],signal:AbortSignal)=>Promise<ProjectIdentity[]>;
/** A directory belongs to one page; nothing survives disposal or uses persistent storage. */
export function createProjectDirectory(lookup:Transport){
 const entries=reactive<Record<string,IdentityEntry>>(Object.create(null)),epoch=ref(0);
 const pending=new Map<string,ProjectRef>(),controllers=new Set<AbortController>();
 let active=0,scheduled=false,disposed=false;
 function schedule(){if(scheduled||disposed)return;scheduled=true;queueMicrotask(()=>{scheduled=false;pump();});}
 function ensure(projects:ProjectRef[]){
  if(disposed)return;
  for(const raw of projects){const p=normalizedProject(raw),key=projectKey(p);if(!p.chain||!p.ca||entries[key])continue;
   entries[key]={status:'loading',symbol:null,logoUrl:null};pending.set(key,p);
  }
  schedule();
 }
 function pump(){
  while(!disposed&&active<2&&pending.size){
   const batch=[...pending.values()].slice(0,20),generation=epoch.value,controller=new AbortController();
   for(const p of batch)pending.delete(projectKey(p));active++;controllers.add(controller);
   void Promise.resolve().then(()=>lookup(batch,controller.signal)).then(items=>{
    if(disposed||generation!==epoch.value)return;
    const mapped=new Map(items.map(p=>[projectKey(p),p]));
    for(const p of batch){const info=mapped.get(projectKey(p));entries[projectKey(p)]={status:info?'ready':'missing',symbol:info?.symbol?.trim()||null,logoUrl:safeLogo(info?.logoUrl)};}
   }).catch(()=>{
    if(disposed||generation!==epoch.value)return;
    for(const p of batch)entries[projectKey(p)]={status:'error',symbol:null,logoUrl:null};
   }).finally(()=>{active--;controllers.delete(controller);schedule();});
  }
 }
 function retry(p:ProjectRef){const key=projectKey(p);if(entries[key]?.status==='loading')return;delete entries[key];ensure([p]);}
 function clear(){epoch.value++;pending.clear();for(const controller of controllers)controller.abort();for(const key of Object.keys(entries))delete entries[key];}
 function dispose(){disposed=true;clear();}
 return {entries,epoch,ensure,retry,clear,dispose};
}
export type ProjectDirectory=ReturnType<typeof createProjectDirectory>;
