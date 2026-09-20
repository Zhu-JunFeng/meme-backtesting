import { computed, onScopeDispose, reactive, watch } from "vue";

export interface CaRow { chain:string; ca:string; poolCount:number; availablePoolCount?:number; pairIds?:string[]; minTime?:string; maxTime?:string }
interface Dimension { interval:string; valueType:string; startTime:string; endTime:string }
interface Page { items:CaRow[]; total:number }
export type CaFetcher = (params:Record<string,unknown>)=>Promise<Page>;
export const caKey=(r:Pick<CaRow,"chain"|"ca">)=>JSON.stringify([r.chain,r.ca]);
const unique=(rows:CaRow[])=>[...new Map(rows.map(r=>[caKey(r),r])).values()];
const errorText=(error:any)=>error.response?.data?.message || error.message || "查询失败，请重试";

// Owned by the creation page: viewing a run must not discard chains or exclusions.
export function useCaSelection(dimension:()=>Dimension, fetchPage:CaFetcher) {
 const state=reactive({
  chains:[] as string[], excluded:[] as CaRow[], selected:[] as CaRow[],
  search:"", sort:"ca", page:1, rows:[] as CaRow[], total:0,
  listLoading:false, bulkLoading:false, listError:"", bulkError:""
 });
 let listEpoch=0,bulkEpoch=0,disposed=false;
 const baseParams=()=>{
  const d=dimension();
  return {interval:d.interval,type:d.valueType,startTime:d.startTime?new Date(d.startTime).toISOString():undefined,endTime:d.endTime?new Date(d.endTime).toISOString():undefined,chains:state.chains.join(",")};
 };
 const listParams=()=>({...baseParams(),ca:state.search.trim() || undefined,sort:state.sort,page:state.page,pageSize:20});
 const blocked=computed(()=>state.listLoading || state.bulkLoading || !!state.listError || !!state.bulkError);
 const snapshot=()=>({...listParams(),selectedChains:[...state.chains],excludedCas:state.excluded.map(({chain,ca})=>({chain,ca}))});
 async function loadList() {
  const epoch=++listEpoch;state.listLoading=true;state.listError="";
  try {
   const data=await fetchPage(listParams());
   if(disposed || epoch!==listEpoch)return;
   state.rows=data.items;state.total=data.total;
  } catch(error) {if(!disposed && epoch===listEpoch){state.rows=[];state.total=0;state.listError=errorText(error);}}
  finally {if(!disposed && epoch===listEpoch)state.listLoading=false;}
 }
 async function collect(params:Record<string,unknown>,epoch:number) {
  const found:CaRow[]=[];let total:number|undefined;
  for(let page=1;;page++){
   const data=await fetchPage({...params,page,pageSize:1000});
   if(disposed || epoch!==bulkEpoch)return;
   if(total!==undefined && total!==data.total)throw new Error("查询期间数据发生变化，请重试以获取完整名单");
   total=data.total;found.push(...data.items);
   if(page*1000>=total)break;
   if(!data.items.length)throw new Error("名单分页不完整，请重试");
  }
  const deduped=unique(found);
  if(deduped.length!==total)throw new Error("名单分页不完整，请重试");
  return deduped;
 }
 async function syncChains() {
  const epoch=++bulkEpoch;state.bulkError="";
  if(!state.chains.length){state.bulkLoading=false;return;}
  state.bulkLoading=true;
  try {
   // Search and display pagination never narrow automatic chain selection.
   const rows=await collect({...baseParams(),sort:"ca"},epoch);
   if(!rows || disposed || epoch!==bulkEpoch)return;
   const excluded=new Set(state.excluded.map(caKey));
   state.selected=unique([...state.selected.filter(r=>!state.chains.includes(r.chain)),...rows.filter(r=>!excluded.has(caKey(r)))]);
  } catch(error){if(!disposed && epoch===bulkEpoch)state.bulkError=errorText(error);}
  finally{if(!disposed && epoch===bulkEpoch)state.bulkLoading=false;}
 }
 function change(keys:unknown[]) {
  if(blocked.value)return;
  const checked=new Set(keys.map(String));
  const available=new Map([...state.selected,...state.rows].map(r=>[caKey(r),r]));
  const exclusions=new Map(state.excluded.map(r=>[caKey(r),r]));
  for(const row of state.rows) {
   if(!state.chains.includes(row.chain))continue;
   if(checked.has(caKey(row)))exclusions.delete(caKey(row));
   else exclusions.set(caKey(row),row);
  }
  state.excluded=[...exclusions.values()];
  state.selected=[...checked].map(k=>available.get(k)).filter((r):r is CaRow=>!!r);
 }
 async function selectAll() {
  if(blocked.value)return;
  const epoch=++bulkEpoch;state.bulkLoading=true;state.bulkError="";
  try {
   const rows=await collect(listParams(),epoch);
   if(!rows || disposed || epoch!==bulkEpoch)return;
   const restored=new Set(rows.map(caKey));
   state.excluded=state.excluded.filter(r=>!restored.has(caKey(r)));
   state.selected=unique([...state.selected,...rows]);
  } catch(error){if(!disposed && epoch===bulkEpoch)state.bulkError=errorText(error);}
  finally{if(!disposed && epoch===bulkEpoch)state.bulkLoading=false;}
 }
 function clear() {
  ++bulkEpoch;state.bulkLoading=false;state.bulkError="";
  state.chains=[];state.excluded=[];state.selected=[];
 }
 function search() {
  if(!state.chains.length){++bulkEpoch;state.bulkLoading=false;state.bulkError="";}
  state.page=1;void loadList();
 }
 function setPage(page:number){state.page=page;void loadList();}
 async function retry(){
  const retryBulk=!!state.bulkError;
  if(state.chains.length){await Promise.all([loadList(),syncChains()]);return;}
  await loadList();
  if(retryBulk){state.bulkError="";await selectAll();}
 }
 watch(()=>JSON.stringify([dimension().interval,dimension().valueType,dimension().startTime,dimension().endTime,state.chains]),(_next,previous)=>{
  const previousChains:string[]=previous ? JSON.parse(previous)[4] : [];
  const removed=new Set(previousChains.filter(c=>!state.chains.includes(c)));
  state.selected=state.selected.filter(r=>!removed.has(r.chain));
  state.excluded=state.excluded.filter(r=>state.chains.includes(r.chain));
  state.page=1;void loadList();void syncChains();
 },{immediate:true,flush:"sync"});
 watch(()=>state.sort,search);
 onScopeDispose(()=>{disposed=true;listEpoch++;bulkEpoch++;});
 return {state,blocked,snapshot,loadList,syncChains,change,selectAll,clear,search,setPage,retry};
}
export type CaSelection=ReturnType<typeof useCaSelection>;
