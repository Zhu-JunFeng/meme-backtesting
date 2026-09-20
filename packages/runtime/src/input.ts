import type { Pool } from 'pg';
export const inputOwner=(run:{id:string;input_source_run_id?:string|null})=>run.input_source_run_id ?? run.id;
/** Shared inputs must match exactly; never fall back to mutable source candles. */
export async function validateInputSource(pool:Pool,run:any){
 if(!run.input_source_run_id)return;
 const source=(await pool.query('SELECT * FROM backtest_runs WHERE id=$1',[inputOwner(run)])).rows[0];
 if(!source?.input_ready || source.status!=='completed' || source.input_source_run_id || !run.input_ready)throw new Error('共享冻结输入来源不可用');
 for(const key of ['symbols','pools','interval','valueType','startTime','endTime'])if(JSON.stringify(run.config_json[key])!==JSON.stringify(source.config_json[key]))throw new Error(`共享冻结输入不匹配：${key}`);
}
