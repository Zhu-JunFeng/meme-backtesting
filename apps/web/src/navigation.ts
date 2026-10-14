export type Page = 'backtest'|'strategy'|'paper'|'live'|'operations';
export type WorkspaceTab = 'runs'|'create';
export function parseRoute(hash:string):{page:Page;tab:WorkspaceTab;runId?:string} {
 const parts=hash.replace(/^#\/?/,'').split('/');
 const page:Page=['backtest','strategy','paper','live','operations'].includes(parts[0])?parts[0] as Page:'backtest';
 if(page!=='paper'&&page!=='live')return {page,tab:'runs'};
 const runId=parts[1]==='runs'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[2]??'')?parts[2]:undefined;
 return {page,tab:parts[1]==='create'?'create':'runs',...(runId?{runId}:{})};
}
export function workspaceUrl(mode:'paper'|'live',tab:WorkspaceTab='runs',id?:string){return `#/${mode}/${id?`runs/${id}`:tab}`;}
