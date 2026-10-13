import {afterEach,it,expect,vi} from 'vitest';
import {defaultProjectSources,SOURCE_WALLETS} from '@meme/domain';
import {ProjectDiscovery} from './project-discovery.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function discovery(request:any,deliver:any=vi.fn(async()=>{}),provider='xxyy'){
 const config=defaultProjectSources();config.xxyy.enabled=provider==='xxyy';config.wallet.enabled=provider==='wallet';config.memeinfo.enabled=false;
 const d:any=new ProjectDiscovery({query:vi.fn(async()=>({rows:[]}))} as any,deliver,request);d.runs=[{chain:'sol',project_sources:config}];return d;
}
it('recovers a permanently pending HTTP request and discards its late response',async()=>{
 vi.useFakeTimers();vi.stubEnv('XXYY_API_KEY','test');let resolve:any;
 const request=vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue({ok:true,json:async()=>({code:200,data:{items:[]}})});
 const d=discovery(request);d.tick();await vi.advanceTimersByTimeAsync(8001);expect(d.feedBusy).toBe(false);expect(d.status.xxyy.state).toBe('stalled');expect(d.status.xxyy.timeouts).toBe(1);
 await vi.advanceTimersByTimeAsync(15000);d.tick();await vi.advanceTimersByTimeAsync(1);expect(d.status.xxyy.lastSuccessAt).toBeDefined();
 resolve({ok:true,json:async()=>({code:200,data:{items:[{tokenAddress:SOURCE_WALLETS[0]}]}})});await vi.advanceTimersByTimeAsync(1);expect(d.status.xxyy.scanned).toBe(0);await d.close();
});
it('bounds response parsing as well as fetch',async()=>{
 vi.useFakeTimers();vi.stubEnv('XXYY_API_KEY','test');const d=discovery(vi.fn(async()=>({ok:true,json:()=>new Promise(()=>{})})));d.tick();await vi.advanceTimersByTimeAsync(8001);expect(d.feedBusy).toBe(false);await d.close();
});
it('invalidates delivery guards and releases the scan when admission hangs',async()=>{
 vi.useFakeTimers();vi.stubEnv('XXYY_API_KEY','test');let valid:any;const deliver=vi.fn((_s,v)=>{valid=v;return new Promise<void>(()=>{});});const d=discovery(vi.fn(async()=>({ok:true,json:async()=>({code:200,data:{items:[{tokenAddress:SOURCE_WALLETS[0]}]}})})),deliver);
 d.tick();await vi.advanceTimersByTimeAsync(15001);expect(d.feedBusy).toBe(false);expect(valid()).toBe(false);await d.close();
});
it('wallet RPC queue timeout resets the chain and a new round succeeds',async()=>{
 vi.useFakeTimers();const d=discovery(vi.fn(async()=>({ok:true,json:async()=>({result:[]})})),undefined,'wallet');d.rpcChain=new Promise(()=>{});d.tick();await vi.advanceTimersByTimeAsync(15001);expect(d.walletBusy).toBe(false);expect(d.status.wallet.timeouts).toBe(1);await vi.advanceTimersByTimeAsync(15000);d.tick();await vi.advanceTimersByTimeAsync(2500);expect(d.status.wallet.lastSuccessAt).toBeDefined();await d.close();
});
it('shutdown cancels an unresponsive scan without waiting for its request',async()=>{
 vi.useFakeTimers();vi.stubEnv('XXYY_API_KEY','test');const d=discovery(vi.fn(()=>new Promise(()=>{})));d.tick();await d.close();expect(d.feedBusy).toBe(false);
});
