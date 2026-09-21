/** Both TradingView marks and drawing anchors must reference an actual loaded bar.
 * Times in events/bars are milliseconds; TradingView windows are seconds.
 */
export function partitionMarkers<T extends {time:unknown}>(events:T[],loaded:ReadonlySet<number>,range:{from:number;to:number}){
 const inRange=events.filter(e=>Number.isFinite(Number(e.time))&&Number(e.time)>=range.from*1000&&Number(e.time)<=range.to*1000);
 return {drawable:inRange.filter(e=>loaded.has(Number(e.time))),missing:inRange.filter(e=>!loaded.has(Number(e.time)))};
}
