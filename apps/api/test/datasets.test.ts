import {describe,it,expect,vi} from "vitest";
import {bounds,resolveDataset,runCas,resultRows,marketCas} from "../src/datasets.js";
describe("dataset selection",()=>{
 it("allows empty and one-sided time bounds, rejects malformed ranges",()=>{
 expect(bounds({}).start).toBe(0);expect(bounds({startTime:"2026-01-01"}).start).toBe(Date.parse("2026-01-01"));
 expect(bounds({endTime:"2026-01-01"}).end).toBe(Date.parse("2026-01-01"));
 expect(()=>bounds({startTime:"invalid"})).toThrow();expect(()=>bounds({startTime:"2026-02-01",endTime:"2026-01-01"})).toThrow();
 });
 it("expands all pools and freezes data/no-data boundaries without forcing dates",async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{chain:"sol",ca:"a",pairId:"p",startTime:"100",endTime:"200",noData:false},{chain:"sol",ca:"a",pairId:"q",startTime:null,endTime:null,noData:true}]});
 const selection:any={cas:[{chain:"SOL",ca:"a"},{chain:"SOL",ca:"a"}],interval:"30s",valueType:"mcap"};
 const result=await resolveDataset({query} as any,selection);
 expect(result.symbols).toHaveLength(2);expect(result.pools?.[1].noData).toBe(true);expect(result.startTime).toBeUndefined();
 expect(JSON.parse(query.mock.calls[0][1][0])).toHaveLength(1);
 expect(query.mock.calls[0][1][5]).toBe(true);
 selection.cas.push({chain:"sol",ca:"b"});expect(result.selection?.cas).toHaveLength(2);
 });
 it("preserves explicit legacy pool selection and rejects a selected CA without data",async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{chain:"sol",ca:"a",pairId:"p",startTime:1,endTime:2,noData:false}]});
 await resolveDataset({query} as any,{symbols:[{chain:"sol",ca:"a",pairId:"p"}],interval:"1m",valueType:"price"});
 expect(query.mock.calls[0][1][5]).toBe(false);
 await expect(resolveDataset({query} as any,{cas:[{chain:"sol",ca:"missing"}],interval:"1m",valueType:"price"})).rejects.toThrow("没有有效");
 });
 it("queries exact CA and dimension; all chains use an empty array",async()=>{
 const query=vi.fn().mockResolvedValue({rows:[]});
 await marketCas({query} as any,{interval:"1m",type:"price",ca:"ExactCaseSensitiveCA"});
 expect(query.mock.calls[0][1].slice(0,2)).toEqual(["1m","price"]);expect(query.mock.calls[0][1][4]).toEqual([]);expect(query.mock.calls[0][1][5]).toBe("ExactCaseSensitiveCA");
 });
});
describe("run detail compatibility",()=>{
 it("includes zero-trade CA, combines all pools and reconciles realized profit",async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{report_json:{engineVersion:"portfolio-2",openPositions:[]}}]}).mockResolvedValueOnce({rows:[{chain:"sol",ca:"a",pair_id:"p",trades:1,entries:1,realized:"12",costs:"3"},{chain:"sol",ca:"a",pair_id:"q",trades:1,entries:1,realized:"-2",costs:"1"}]});
 const config={symbols:[{chain:"sol",ca:"a",pairId:"p"},{chain:"sol",ca:"a",pairId:"q"},{chain:"sol",ca:"zero",pairId:"r"}]};
 const result=await runCas({query} as any,{id:"run",config_json:config},{});
 expect(result.total).toBe(2);expect(result.summary.realizedPnl).toBe(10);expect(result.summary.untradedCaCount).toBe(1);expect(result.items.find((r:any)=>r.ca==="a").poolCount).toBe(2);
 });
 it("does not invent legacy floating PNL",async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{report_json:{netPnl:0}}]}).mockResolvedValueOnce({rows:[]});
 const result=await runCas({query} as any,{id:"run",config_json:{symbols:[{chain:"sol",ca:"a",pairId:"p"}]}},{chain:"sol",ca:"a"},true);
 expect(result.unrealizedPnl).toBeNull();expect(result.pools[0].noData).toBeNull();
 });
 it("binds event filters and pagination without SQL interpolation",async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{count:"1"}]}).mockResolvedValueOnce({rows:[{id:"event"}]});
 const result=await resultRows({query} as any,"run","signals",{chain:"sol",ca:"a",pairId:"p",from:"100",to:"200",page:"2",pageSize:"20"});
 expect(result.items).toHaveLength(1);expect(query.mock.calls[1][1]).toEqual(["run","sol","a","p",100,200,20,20]);
 expect(query.mock.calls[1][0]).toContain("ORDER BY time,id");
 });
});

