"""Unit tests plus optional isolated-schema PostgreSQL transaction tests."""
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from test_import_meme_klines import importer as m, make_xlsx

HEADERS = ['所属链','合约地址','触发时间戳（毫秒）','触发时间（北京时间）','信号名称','信号代码','信号来源','信号ID','明细ID']
ROW = ['BSC','0xAbC','1700000000123','2023-11-15 06:13:20','name','fomo_new_project','FOMO','s1','d1']


class SignalTests(unittest.TestCase):
    def test_recent_creation_boundary(self):
        now=1800000000000
        cutoff=now-30*m.HISTORY_MS
        projects=[m.Project('sol',str(t),'p',t) for t in [cutoff-1,cutoff,now,now+1]]
        included,excluded=m.recent_projects(projects,now,30)
        self.assertEqual([p.created_ms for p in included],[cutoff,now])
        self.assertEqual([p.created_ms for p in excluded],[cutoff-1,now+1])

    def test_normalization_dedup_and_chain_filter(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'test.xlsx'
            make_xlsx(p, [HEADERS, ROW, ROW, ['sol','AbC',*ROW[2:]], ['eth','ignored',*ROW[2:]]])
            events = m.read_signals(p, {'bsc','sol'})
            self.assertEqual([(e['chain'],e['ca']) for e in events], [('bsc','0xabc'),('sol','AbC')])
            self.assertEqual(len(events[0]['provenance']),2)
            self.assertEqual(events[0]['signal_time'],1700000000123)

    def test_invalid_time_and_conflicting_identity(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'test.xlsx'
            bad = list(ROW); bad[3]='2023-11-15 06:13:21'
            make_xlsx(p,[HEADERS,bad])
            with self.assertRaisesRegex(m.ImporterError,'mismatch'): m.read_signals(p,set())
            bad = list(ROW); bad[4]='changed'
            make_xlsx(p,[HEADERS,ROW,bad])
            with self.assertRaisesRegex(m.ImporterError,'conflicting'): m.read_signals(p,set())

    def test_creation_24h_and_young_project_boundaries(self):
        project = m.Project('sol','CA','pair',60001)
        for now in [120001, project.created_ms + 2*m.HISTORY_MS]:
            calls=[]
            def request(url,payload,*args):
                calls.append(payload)
                return {'code':0,'data':[{'time':t,'price':dict(open=1,high=1,low=1,close=1,volume=1)}
                    for t in [30000,60000,payload['to']-payload['interval']*1000,payload['to'],payload['to']+60000]]}
            result=m.fetch_project(project,now,1,0,request)
            self.assertEqual(len(calls),4)
            self.assertEqual(set((r.interval,r.value_type) for r in result.rows),{('30s','price'),('30s','mcap'),('1m','price'),('1m','mcap')})
            self.assertTrue(all(r.open_time>=60000 and r.close_time<=min(now,project.created_ms+m.HISTORY_MS) for r in result.rows))
            self.assertTrue(all(p['to']<=min(now,project.created_ms+m.HISTORY_MS) for p in calls))

    def test_http_failure_retains_other_combinations(self):
        def request(url,payload,*args):
            if payload['valueType']=='mc': raise RuntimeError('unavailable')
            return {'code':0,'data':[{'time':60000,'price':dict(open=1,high=1,low=1,close=1,volume=1)}]}
        r=m.fetch_project(m.Project('sol','ca','p',60001),180000,1,0,request)
        self.assertEqual(len(r.errors),2)
        self.assertEqual(len(r.rows),2)

    def test_cancel_performs_no_write_or_candle_fetch(self):
        args=m.build_parser().parse_args(['fake.xlsx'])
        with patch.dict(os.environ,{'DATABASE_URL':'postgresql://example/db'}), \
             patch.object(m,'read_tokens',return_value=[m.TokenRef('sol','ca',1)]), \
             patch.object(m,'read_signals',return_value=[dict(chain='sol',ca='ca')]), \
             patch.object(m,'lookup_projects',return_value=([m.Project('sol','ca','p',int(m.time.time()*1000)-1000)],[])), \
             patch.object(m,'preflight_database'), patch.object(m,'preflight_signals'), \
             patch('builtins.input',return_value='NO'), patch.object(m,'write_rows') as write, \
             patch.object(m,'fetch_project') as fetch:
            self.assertEqual(m.run(args),0)
            write.assert_not_called(); fetch.assert_not_called()


@unittest.skipUnless(os.environ.get('IMPORT_TEST_DATABASE_URL'),'optional local PostgreSQL fixture')
class TransactionTests(unittest.TestCase):
    def test_atomic_idempotent_and_conflict_rollback(self):
        url=os.environ['IMPORT_TEST_DATABASE_URL']
        schema='import_test_'+uuid.uuid4().hex
        root=Path(__file__).resolve().parents[4]
        migration=(root/'apps/api/migrations/008_token_signals.sql').read_text().replace('public.',schema+'.')
        project=m.Project('sol',"CA'quoted",'pair',60001)
        event=dict(chain=project.chain,ca=project.ca,signal_source='fomo_new_project',detail_id='d1',signal_time=80000,source_signal={'name':"O'Brien"},provenance=[{'file':'one'}])
        row=m.candle_row(project,30,'30s','price',{'time':60000,'price':dict(open=1,high=2,low=1,close=2,volume=3)},60001,120000)
        try:
            m.run_psql(url,f'CREATE SCHEMA {schema};'+migration)
            m.run_psql(url,f'''CREATE TABLE {schema}.meme_kline(chain text,ca text,pair_id text,interval text,open_time bigint,close_time bigint,
open numeric,high numeric,low numeric,close numeric,volume numeric,trade_count bigint,type text,source text,raw_data jsonb,valid boolean,invalid_reason text,
UNIQUE(chain,pair_id,interval,open_time,type));''')
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'rows.csv'
                with p.open('w') as f:m.write_csv_rows(f,[row])
                def apply(events):return m.run_psql(url,m.build_upsert_sql(p,m.metadata_sql(project,events)).replace('public.',schema+'.'),connection_retries=0)
                self.assertIn('RESULT|1|0',apply([event]))
                self.assertIn('RESULT|0|1',apply([event]))
                self.assertIn('SIGNALS|0|1',apply([event]))
                earlier={**event,'detail_id':'d0','signal_time':70000}
                apply([earlier]);apply([event])
                self.assertEqual(m.run_psql(url,f'SELECT signal_time FROM {schema}.token_info;').strip(),'70000')
                with self.assertRaisesRegex(m.ImporterError,'conflicting'):
                    apply([{**event,'signal_time':90000}])
                counts=m.run_psql(url,f'SELECT (SELECT count(*) FROM {schema}.meme_kline),(SELECT count(*) FROM {schema}.token_signal_events);').strip()
                self.assertEqual(counts,'1|2')
                # Force a later SQL failure: neither metadata nor candle changes can commit.
                sql=m.build_upsert_sql(p,m.metadata_sql(project,[{**event,'detail_id':'rollback'}])).replace('public.',schema+'.').replace('COMMIT;','SELECT 1/0; COMMIT;')
                with self.assertRaises(m.ImporterError):m.run_psql(url,sql,connection_retries=0)
                self.assertEqual(m.run_psql(url,f"SELECT count(*) FROM {schema}.token_signal_events WHERE detail_id='rollback';").strip(),'0')
        finally:
            m.run_psql(url,f'DROP SCHEMA IF EXISTS {schema} CASCADE;')


if __name__=='__main__':unittest.main()
