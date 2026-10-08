import 'reflect-metadata';
import {describe,expect,it,vi} from 'vitest';
import {lookupProjects,mapProjectIdentities,validateProjects} from './project-lookup.js';

const envelope=(items:any[])=>({success:true,code:'200',data:{caListTokenList:items}});
describe('presentation project lookup',()=>{
 it('deduplicates by chain/address, preserving SOL case and normalizing EVM',()=>{
  expect(validateProjects({projects:[{chain:' SOL ',ca:'AbC'},{chain:'sol',ca:'AbC'},{chain:'sol',ca:'abc'},{chain:'ROBIN',ca:'0xABCD'},{chain:'robin',ca:'0xabcd'}]})).toEqual([{chain:'sol',ca:'AbC'},{chain:'sol',ca:'abc'},{chain:'robin',ca:'0xabcd'}]);
  for(const body of [{},{projects:[]},{projects:Array.from({length:21},()=>({chain:'sol',ca:'A'}))},{projects:[{chain:'bad chain',ca:'A'}]},{projects:[{chain:'sol',ca:''}]}])expect(()=>validateProjects(body)).toThrow();
 });
 it('matches both chain and CA and safely falls back from top-level fields',()=>{
  const projects=validateProjects({projects:[{chain:'sol',ca:'AbC'},{chain:'bsc',ca:'0xAB'},{chain:'robin',ca:'0xab'},{chain:'sol',ca:'missing'}]});
  expect(mapProjectIdentities(envelope([
   {chain:'sol',token_address:'abc',symbol:'wrong case'},
   {chain:'sol',token_address:'AbC',symbol:' <b>TEXT</b> ',image_url:'https://example.com/top.png',project_meta:{symbol:'fallback'}},
   {chain:'bsc',token_address:'0xAB',symbol:' ',image_url:'javascript:alert(1)',project_meta:{symbol:'FALLBACK',image_url:'https://example.com/fallback.png'}},
   {chain:'robin',token_address:'0xAB',image_url:'data:image/png;base64,abc'},
   {chain:'eth',token_address:'0xab',symbol:'wrong chain'},
  ]),projects)).toEqual([
   {chain:'sol',ca:'AbC',symbol:'<b>TEXT</b>',logoUrl:'https://example.com/top.png'},
   {chain:'bsc',ca:'0xab',symbol:'FALLBACK',logoUrl:'https://example.com/fallback.png'},
   {chain:'robin',ca:'0xab',symbol:null,logoUrl:null},
  ]);
 });
 it('forwards only the fixed upstream contract, without browser Origin or persistence',async()=>{
  const transport=vi.fn(async()=>new Response(JSON.stringify(envelope([{chain:'sol',token_address:'A',symbol:'TEST'}]))));
  expect(await lookupProjects({projects:[{chain:'sol',ca:'A'}]},transport as typeof fetch)).toEqual({items:[{chain:'sol',ca:'A',symbol:'TEST',logoUrl:null}]});
  const [url,options]=transport.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://app.memeinfo.net/api/projects/lookup');expect(options.headers).toEqual({'Content-Type':'application/json'});
  expect(JSON.parse(options.body as string)).toEqual({caList:['A'],symbolList:['']});expect(options.signal).toBeInstanceOf(AbortSignal);
 });
 it('rejects HTTP/business/JSON failures and distinguishes timeouts',async()=>{
  for(const response of [new Response('bad',{status:503}),new Response('not json'),new Response(JSON.stringify({success:false,code:'500'})),new Response(JSON.stringify({success:true,code:'200',data:{}}))]){
   await expect(lookupProjects({projects:[{chain:'sol',ca:'A'}]},(async()=>response) as typeof fetch)).rejects.toMatchObject({status:502});
  }
  await expect(lookupProjects({projects:[{chain:'sol',ca:'A'}]},(async()=>{throw new DOMException('late','TimeoutError');}) as typeof fetch)).rejects.toMatchObject({status:504});
 });
});
