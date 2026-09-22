import {it,expect,vi} from 'vitest';
import {AppService} from '../src/main.js';
import {resolveSignalDataset} from '../src/token-signals.js';
vi.mock('../src/token-signals.js',()=>({resolveSignalDataset:vi.fn(),externalSignalsForRun:vi.fn()}));
it.each([undefined,true,false])('new tasks resolve database gates with setting %s without mutating old versions',async setting=>{
 const service=Object.create(AppService.prototype) as AppService;
 const original:any={schemaVersion:1,executionConfig:{},...(setting===undefined?{}:{entryAfterSignal:setting}),entrySignals:[{chain:'sol',ca:'a',signalTime:0}]};
 const gates=setting===false?undefined:[{chain:'sol',ca:'a',signalTime:15001}];
 vi.mocked(resolveSignalDataset).mockResolvedValue({symbols:[{chain:'sol',ca:'a',pairId:'p'}],interval:'30s',valueType:'mcap',entrySignals:gates,externalSignals:[]});
 const query=vi.fn().mockResolvedValue({rows:[{id:'run',dispatch_no:0}]});
 Object.defineProperty(service,'pool',{value:{query}});Object.defineProperty(service,'queue',{value:{add:vi.fn()}});
 service.version=vi.fn().mockResolvedValue({id:'v',templateId:'t',strategyJson:original});service.validateStrategy=vi.fn();
 await service.createBacktest({name:'test',strategyVersionId:'v',dataset:{cas:[{chain:'sol',ca:'a'}],interval:'30s',valueType:'mcap'}});
 expect(resolveSignalDataset).toHaveBeenLastCalledWith(service.pool,expect.anything(),setting??true);
 const saved=JSON.parse(query.mock.calls[0][1][4]);expect(saved.entryAfterSignal).toBe(setting??true);expect(saved.entrySignals).toEqual(gates);
 expect(original.entryAfterSignal).toBe(setting);expect(original.entrySignals[0].signalTime).toBe(0);
});
