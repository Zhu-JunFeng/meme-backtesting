import {it,expect,vi} from 'vitest';
import {operationsAlerts,OperationsSampler} from './operations.js';
it('does not confuse no trades with a disconnected feed, and detects expired samples',()=>{
 const now=Date.now(),samples=[{source:'worker',sampled_at:new Date(now).toISOString(),metrics:{connections:[{name:'market',enabled:true,state:'connected',lastMessageAt:now-500000}],discovery:{xxyy:{state:'connected',scanned:0}}}},{source:'api',sampled_at:new Date(now).toISOString(),metrics:{host:{sampledAt:now,diskPercent:20,inodePercent:10}}}];expect(operationsAlerts(samples,now)).toEqual([]);expect(operationsAlerts(samples,now+180001).map(a=>a.key)).toContain('worker:stale');
});
it('does not overlap slow samples and retains current state when the database fails',async()=>{
 const sampler=new OperationsSampler('worker',()=>({tasks:{paper:2}}));let release:any;
 const query=vi.spyOn(sampler.pool,'query').mockImplementationOnce(()=>new Promise(r=>release=r) as any).mockResolvedValue({rows:[],rowCount:0} as never);
 const first=sampler.sample();await sampler.sample();expect(query).toHaveBeenCalledTimes(1);release({rows:[]});await first;expect(sampler.latest.metrics.tasks.paper).toBe(2);
 query.mockRejectedValueOnce(new Error('connection refused'));await sampler.sample();expect(sampler.latest.metrics.database.state).toBe('error');expect(sampler.latest.metrics.tasks.paper).toBe(2);await sampler.close();
});
it('reports scanner and dependency failures plus disk pressure',()=>{
 const now=Date.now();const alerts=operationsAlerts([{source:'worker',sampled_at:new Date(now).toISOString(),metrics:{discovery:{wallet:{state:'stalled',error:'RPC超时'}}}},{source:'api',sampled_at:new Date(now).toISOString(),metrics:{database:{state:'error'},host:{sampledAt:now,diskPercent:96},resourcePressure:3}}],now);expect(alerts.map(a=>a.key)).toEqual(expect.arrayContaining(['scan:wallet','database','diskPercent','host:pressure']));
});
