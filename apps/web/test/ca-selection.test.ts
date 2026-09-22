import { effectScope, reactive } from "vue";
import { describe,expect,it,vi } from "vitest";
import { caKey,useCaSelection,type CaFetcher,type CaRow } from "../src/composables/useCaSelection";

const row=(ca:string,chain="sol"):CaRow=>({chain,ca,poolCount:ca==="a"?2:1});
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function setup(fetcher?:CaFetcher){
 const dimension=reactive({interval:"30s",valueType:"mcap",startTime:"",endTime:""});
 const all=[row("a"),row("b"),row("r","robin")];
 const fetch=vi.fn(fetcher ?? (async p=>{
  const chains=String(p.chains || "").split(",").filter(Boolean);
  const items=all.filter(r=>(!chains.length || chains.includes(r.chain)) && (!p.ca || p.ca===r.ca));
  return {items,total:items.length};
 }));
 const scope=effectScope();
 const selection=scope.run(()=>useCaSelection(()=>dimension,fetch))!;
 return {dimension,fetch,selection,stop:()=>scope.stop()};
}
describe("chain-driven CA selection",()=>{
 it("does not auto-select without chains; selecting a chain selects every matching CA",async()=>{
  const t=setup();await settle();expect(t.selection.state.selected).toEqual([]);
  t.selection.state.chains=["sol"];expect(t.selection.blocked.value).toBe(true);await settle();
  expect(t.selection.state.selected.map(caKey)).toEqual([caKey(row("a")),caKey(row("b"))]);expect(t.selection.blocked.value).toBe(false);t.stop();
 });
 it("ignores display search and pagination when collecting a chain",async()=>{
  const t=setup();await settle();t.selection.state.search="a";t.selection.search();await settle();
  t.selection.state.chains=["sol"];await settle();
  expect(t.selection.state.rows).toHaveLength(1);expect(t.selection.state.selected).toHaveLength(2);
  t.selection.setPage(2);await settle();expect(t.selection.state.selected).toHaveLength(2);t.stop();
 });
 it("preserves exclusions across dimensions and restores them when rechecked",async()=>{
  const t=setup();t.selection.state.chains=["sol"];await settle();
  t.selection.change([caKey(row("b"))]);expect(t.selection.state.excluded.map(r=>r.ca)).toEqual(["a"]);
  t.dimension.interval="1m";t.dimension.valueType="price";t.dimension.startTime="2026-09-01T00:00";await settle();
  expect(t.fetch.mock.calls.at(-1)?.[0].startTime).toBe('2026-08-31T16:00:00.000Z');
  expect(t.selection.state.selected.map(r=>r.ca)).toEqual(["b"]);
  t.selection.change([caKey(row("a")),caKey(row("b"))]);expect(t.selection.state.excluded).toEqual([]);t.stop();
 });
 it("merges multiple chains and discards removed-chain exclusions",async()=>{
  const t=setup();t.selection.state.chains=["sol","robin"];await settle();
  t.selection.change([caKey(row("b")),caKey(row("r","robin"))]);
  t.selection.state.chains=["robin"];await settle();
  expect(t.selection.state.selected.map(r=>r.chain)).toEqual(["robin"]);expect(t.selection.state.excluded).toEqual([]);
  t.selection.state.chains=["sol","robin"];await settle();expect(t.selection.state.selected).toHaveLength(3);t.stop();
 });
 it("collects all pages atomically and keeps the old list on a later-page failure",async()=>{
  let fail=true;
  const many=Array.from({length:1001},(_,i)=>row(String(i)));
  const t=setup(async p=>{
   if(!p.chains)return {items:[],total:0};
   if(p.pageSize===20)return {items:many.slice(0,20),total:1001};
   if(p.page===2 && fail)throw new Error("page failed");
   return {items:p.page===1?many.slice(0,1000):many.slice(1000),total:1001};
  });
  t.selection.state.selected=[row("old","robin")];t.selection.state.chains=["sol"];await settle();
  expect(t.selection.state.selected).toEqual([row("old","robin")]);expect(t.selection.blocked.value).toBe(true);
  fail=false;await t.selection.retry();expect(t.selection.state.selected).toHaveLength(1002);expect(t.selection.blocked.value).toBe(false);t.stop();
 });
 it("does not apply stale full-list responses after a newer dimension",async()=>{
  let resolveOld!:(data:any)=>void;
  const t=setup(async p=>{
   if(p.chains && p.pageSize===1000 && p.interval==="30s")return new Promise(resolve=>{resolveOld=resolve;});
   return {items:[row(String(p.interval))],total:1};
  });
  t.selection.state.chains=["sol"];await settle();t.dimension.interval="1m";await settle();
  resolveOld({items:[row("stale")],total:1});await settle();
  expect(t.selection.state.selected.map(r=>r.ca)).toEqual(["1m"]);expect(t.selection.blocked.value).toBe(false);t.stop();
 });
 it("clear cancels pending requests and removes chains, selections and exclusions",async()=>{
  let resolveOld!:(data:any)=>void;
  const t=setup(async p=>p.chains && p.pageSize===1000?new Promise(resolve=>{resolveOld=resolve;}):{items:[],total:0});
  t.selection.state.chains=["sol"];await settle();t.selection.clear();resolveOld({items:[row("a")],total:1});await settle();
  expect(t.selection.state.chains).toEqual([]);expect(t.selection.state.selected).toEqual([]);expect(t.selection.state.excluded).toEqual([]);expect(t.selection.blocked.value).toBe(false);t.stop();
 });
 it("an empty chain result replaces its previous selection but retains exclusions",async()=>{
  const t=setup(async p=>p.interval==="30s"?{items:[row("a"),row("b")],total:2}:{items:[],total:0});
  t.selection.state.chains=["sol"];await settle();t.selection.change([caKey(row("b"))]);t.dimension.interval="1m";await settle();
  expect(t.selection.state.selected).toEqual([]);expect(t.selection.state.excluded.map(r=>r.ca)).toEqual(["a"]);expect(t.selection.blocked.value).toBe(false);t.stop();
 });
 it("captures selected chains and excluded CA in snapshot; does not depend on table mounting",async()=>{
  const t=setup();t.selection.state.chains=["sol"];await settle();t.selection.change([caKey(row("b"))]);
  const snapshot=t.selection.snapshot();expect(snapshot.selectedChains).toEqual(["sol"]);expect(snapshot.excludedCas).toEqual([{chain:"sol",ca:"a"}]);
  await t.selection.loadList();expect(t.selection.state.selected.map(r=>r.ca)).toEqual(["b"]);
  t.selection.clear();expect(snapshot.selectedChains).toEqual(["sol"]);t.stop();
 });
 it("manual selection and full-display selection remain available without chains",async()=>{
  const t=setup();await settle();t.selection.change([caKey(row("a"))]);expect(t.selection.state.selected).toEqual([row("a")]);
  await t.selection.selectAll();expect(t.selection.state.selected).toHaveLength(3);expect(t.selection.state.chains).toEqual([]);t.stop();
 });
 it("rejects incomplete or changing pages instead of committing partial results",async()=>{
  const t=setup(async p=>({items:p.page===2?[]:[row("a")],total:p.page===2?1002:1001}));
  t.selection.state.chains=["sol"];await settle();expect(t.selection.blocked.value).toBe(true);expect(t.selection.state.selected).toEqual([]);t.stop();
 });
});
