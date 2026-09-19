import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.env.TRADINGVIEW_LIBRARY_PATH ?? "/Users/zhujf/Documents/code/tradingview组件/charting_library-master_0421/charting_library");
const target = resolve("apps/web/public/charting_library");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
console.log(`TradingView Advanced Charts copied from ${source} to ${target}`);
