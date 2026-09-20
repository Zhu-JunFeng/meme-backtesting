import {it,expect,vi} from "vitest";
import {AppService} from "../src/main.js";
it("restores a template without creating or updating any strategy version",async()=>{
  const service=Object.create(AppService.prototype) as AppService;
  const query=vi.fn().mockResolvedValueOnce({rowCount:1,rows:[{id:"template"}]}).mockResolvedValueOnce({rowCount:1,rows:[{id:"template",status:"active",currentVersionId:"original",currentVersion:2}]});
  Object.defineProperty(service,"pool",{value:{query}});
  const restored=await service.patchTemplate("template",{status:"active"});
  expect(restored.currentVersionId).toBe("original");expect(restored.currentVersion).toBe(2);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0][1]).toEqual(["template",null,null,"active"]);
  expect(query.mock.calls[0][0]).not.toContain("current_version_id=");
  expect(query.mock.calls.every(([sql])=>!sql.includes("INSERT") && !sql.includes("UPDATE backtest_strategy_versions"))).toBe(true);
});
