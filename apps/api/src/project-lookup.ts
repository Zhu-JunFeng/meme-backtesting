import {BadGatewayException,BadRequestException,Controller,Post,Body,Header,HttpCode,GatewayTimeoutException} from '@nestjs/common';

type ProjectRef={chain:string;ca:string};
export type ProjectIdentity=ProjectRef&{symbol:string|null;logoUrl:string|null};
const endpoint='https://app.memeinfo.net/api/projects/lookup';
const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():null;
const key=(project:ProjectRef)=>`${project.chain}:${project.ca}`;
const normalize=(chain:string,ca:string):ProjectRef=>({chain:chain.trim().toLowerCase(),ca:chain.trim().toLowerCase()==='sol'?ca.trim():ca.trim().toLowerCase()});
function imageUrl(value:unknown){
 const raw=text(value);if(!raw)return null;
 try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
export function validateProjects(body:unknown):ProjectRef[]{
 const projects=(body as any)?.projects;
 if(!Array.isArray(projects)||projects.length<1||projects.length>20)throw new BadRequestException('每次查询需提供 1–20 个项目');
 const result=new Map<string,ProjectRef>();
 for(const p of projects){
  if(typeof p?.chain!=='string'||!(/^[a-z0-9_]{1,32}$/i).test(p.chain.trim())||typeof p?.ca!=='string'||!p.ca.trim()||p.ca.trim().length>128)throw new BadRequestException('项目链或 CA 无效');
  const project=normalize(p.chain,p.ca);result.set(key(project),project);
 }
 return [...result.values()];
}
export function mapProjectIdentities(data:any,projects:ProjectRef[]):ProjectIdentity[]{
 if(data?.success!==true||data?.code!=='200'||!Array.isArray(data?.data?.caListTokenList))throw new BadGatewayException('项目资料接口响应无效');
 const wanted=new Set(projects.map(key)),result=new Map<string,ProjectIdentity>();
 for(const item of data.data.caListTokenList){
  if(typeof item?.chain!=='string'||typeof item?.token_address!=='string')continue;
  const p=normalize(item.chain,item.token_address);if(!wanted.has(key(p)))continue;
  result.set(key(p),{...p,symbol:text(item.symbol)??text(item.project_meta?.symbol),logoUrl:imageUrl(item.image_url)??imageUrl(item.project_meta?.image_url)});
 }
 return projects.flatMap(p=>result.has(key(p))?[result.get(key(p))!]:[]);
}
/** Presentation-only, uncached proxy. Never accesses the trading project cache or database. */
export async function lookupProjects(body:unknown,transport:typeof fetch=fetch){
 const projects=validateProjects(body);
 try{
  const response=await transport(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caList:[...new Set(projects.map(p=>p.ca))],symbolList:['']}),signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new BadGatewayException(`项目资料接口 HTTP ${response.status}`);
  return {items:mapProjectIdentities(await response.json(),projects)};
 }catch(error){
  if(error instanceof BadGatewayException)throw error;
  if((error as Error)?.name==='TimeoutError'||(error as Error)?.name==='AbortError')throw new GatewayTimeoutException('项目资料查询超时');
  throw new BadGatewayException('项目资料查询失败，请重试');
 }
}
@Controller('api/projects')
export class ProjectLookupController {
 @Post('lookup') @HttpCode(200) @Header('Cache-Control','no-store') lookup(@Body() body:unknown){return lookupProjects(body);}
}
