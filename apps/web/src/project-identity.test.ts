import {describe,expect,it,vi} from 'vitest';
import {createProjectDirectory,normalizedProject,projectKey,safeLogo,shortCa,type ProjectIdentity,type ProjectRef} from './project-identity';
const projects=(n:number)=>Array.from({length:n},(_,i)=>({chain:'sol',ca:`CA${i}`}));
const identity=(p:ProjectRef):ProjectIdentity=>({...p,symbol:`SYMBOL ${p.ca}`,logoUrl:null});
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
describe('page-only project directory',()=>{
 it('keeps identities distinct across chains and SOL case; abbreviates display only',()=>{
  expect(normalizedProject({chain:' SOL ',ca:' AbC '})).toEqual({chain:'sol',ca:'AbC'});
  expect(projectKey({chain:'ROBIN',ca:'0xABCD'})).toBe('robin:0xabcd');
  expect(projectKey({chain:'sol',ca:'AbC'})).not.toBe(projectKey({chain:'sol',ca:'abc'}));
  expect(shortCa('0x1234567890abcdef')).toBe('0x1234…cdef');expect(shortCa('short')).toBe('short');
  expect(safeLogo('https://example.com/image.png')).toBe('https://example.com/image.png');
  for(const value of [null,'','data:image/png;base64,A','javascript:alert(1)','/local.png'])expect(safeLogo(value)).toBeNull();
 });
 it('batches at 20, caps concurrent requests at two and deduplicates refresh/new CA',async()=>{
  const requests:Array<{batch:ProjectRef[];resolve:(items:ProjectIdentity[])=>void}>=[];
  const lookup=vi.fn((batch:ProjectRef[])=>new Promise<ProjectIdentity[]>(resolve=>requests.push({batch,resolve})));
  const directory=createProjectDirectory(lookup),refs=projects(45);
  directory.ensure([...refs,...refs]);await tick();
  expect(requests.map(r=>r.batch.length)).toEqual([20,20]);
  requests[0].resolve(requests[0].batch.map(identity));await tick();expect(requests.map(r=>r.batch.length)).toEqual([20,20,5]);
  for(const request of requests)request.resolve(request.batch.map(identity));await tick();
  directory.ensure(refs);await tick();expect(lookup).toHaveBeenCalledTimes(3);
  directory.ensure([refs[0],{chain:'sol',ca:'new'}]);await tick();expect(requests[3].batch).toEqual([{chain:'sol',ca:'new'}]);
  requests[3].resolve(requests[3].batch.map(identity));await tick();expect(directory.entries['sol:new'].status).toBe('ready');directory.dispose();
 });
 it('keeps unmatched fields empty, sanitizes logo and retries only on request',async()=>{
  const lookup=vi.fn().mockResolvedValue([]).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{chain:'sol',ca:'CA0',symbol:'<script>plain text</script>',logoUrl:'javascript:bad'}]);
  const directory=createProjectDirectory(lookup);directory.ensure(projects(2));await tick();
  expect(directory.entries['sol:CA0'].status).toBe('error');directory.ensure(projects(2));await tick();expect(lookup).toHaveBeenCalledTimes(1);
  directory.retry(projects(2)[0]);await tick();expect(directory.entries['sol:CA0']).toMatchObject({status:'ready',symbol:'<script>plain text</script>',logoUrl:null});
  directory.retry(projects(2)[1]);await tick();expect(directory.entries['sol:CA1']).toMatchObject({status:'missing',symbol:null,logoUrl:null});directory.dispose();
 });
 it('aborts/fences old page responses and fetches again on re-entry',async()=>{
  const requests:Array<{signal:AbortSignal;resolve:(items:ProjectIdentity[])=>void}>=[];
  const directory=createProjectDirectory((_,signal)=>new Promise(resolve=>requests.push({signal,resolve})));
  directory.ensure(projects(1));await tick();directory.clear();expect(requests[0].signal.aborted).toBe(true);
  directory.ensure(projects(1));await tick();requests[1].resolve([{...projects(1)[0],symbol:'NEW',logoUrl:null}]);await tick();
  requests[0].resolve([{...projects(1)[0],symbol:'OLD',logoUrl:null}]);await tick();expect(directory.entries['sol:CA0'].symbol).toBe('NEW');
  directory.dispose();expect(Object.keys(directory.entries)).toEqual([]);directory.ensure(projects(1));await tick();expect(requests).toHaveLength(2);
 });
});
