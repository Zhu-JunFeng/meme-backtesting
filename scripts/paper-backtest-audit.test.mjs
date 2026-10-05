import test from 'node:test';
import assert from 'node:assert/strict';
import {selectBoughtPools,auditOrders,compareTrades} from './paper-backtest-audit.mjs';

const buy={id:'buy-1',position_id:'buy-1',chain:'robin',ca:'0xabc',pair_id:'pool-1',side:'buy',reason:'entry',status:'filled',decision_time:'180000',fill_time:'180004',fill_value:'100',fill_price:'0.1',quantity:'10',gross_amount:'100',fee:'1',slippage_cost:'1',tax_cost:'1'};
const sell={...buy,id:'sell-1',side:'sell',reason:'stop_loss',decision_time:'240000',fill_time:'240002',fill_value:'89',fill_price:'0.09',gross_amount:'90'};
const signal={id:'signal-1',chain:'robin',ca:'0xabc',kind:'external_signal',event_time:'100123',payload:{source:'top_cluster_first_buy'}};

test('selects only filled-buy pools and uses the paper task signal, not an unrelated earlier token signal',()=>{
 const watches=[{chain:'robin',ca:'0xabc',signal_time:'100123',signal_source:'top_cluster_first_buy'}];
 const events=[{...signal,id:'older',event_time:'90000'},signal];
 const selected=selectBoughtPools([buy,sell,{...buy,id:'other',ca:'0xdef',status:'cancelled'}],watches,events,300000);
 assert.deepEqual(selected.pairs,[{chain:'robin',ca:'0xabc',pairId:'pool-1'}]);
 assert.equal(selected.gates[0].signalTime,100123);
 assert.equal(selected.gates[0].sourceEventId,'signal-1');
 assert.equal(auditOrders([buy,sell],selected.gates,300000).issues.length,0);
});

test('refuses missing signal or a buy decision at the signal boundary',()=>{
 assert.throws(()=>selectBoughtPools([buy],[],[],300000),/缺少/);
 assert.throws(()=>selectBoughtPools([{...buy,decision_time:'100123'}],[],[signal],300000),/未严格晚于/);
});

test('compares entry bucket and exit reason, keeps historical terminal close distinct',()=>{
 const base={chain:'robin',ca:'0xabc',pair_id:'pool-1',trade_no:1,entry_time:'120000',entry_price:'99',exit_time:'240000',exit_price:'90',exit_reason:'stop_loss',net_pnl:'-10'};
 const matching=compareTrades([buy,sell],[base],60000,300000);
 assert.equal(matching.summary.matched,1);
 assert.equal(matching.items[0].reasonMatches,true);
 assert.equal(matching.items[0].entryDeltaBars,0);
 assert.equal(matching.items[0].exitDeltaBars,0);
 assert.equal(matching.items[0].live.netPnl,-16);
 assert.equal(matching.items[0].pnlDelta,-6);
 const end=compareTrades([buy,sell],[{...base,exit_reason:'end_of_backtest'}],60000,300000);
 assert.equal(end.summary.explainable,1);
 assert.equal(end.items[0].backtest.exitReason,'end_of_backtest');
 const absent=compareTrades([buy,sell],[],60000,300000);
 assert.equal(absent.summary.unmatched,1);
 assert.equal(absent.items[0].status,'回测未触发');
});
