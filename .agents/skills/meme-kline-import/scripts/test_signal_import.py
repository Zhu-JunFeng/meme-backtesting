"""Unit tests plus optional isolated-schema PostgreSQL transaction tests."""
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from subprocess import CompletedProcess

from test_import_meme_klines import importer as m, make_xlsx

HEADERS = ['所属链','合约地址','触发时间戳（毫秒）','触发时间（北京时间）','信号名称','信号代码','信号来源','信号ID','明细ID']
ROW = ['BSC','0xAbC','1700000000123','2023-11-15 06:13:20','name','fomo_new_project','FOMO','s1','d1']


class SignalTests(unittest.TestCase):
    def test_reconnect_replays_identical_transaction_with_bounded_backoff(self):
        failed=CompletedProcess([],2,'','server closed the connection unexpectedly')
        succeeded=CompletedProcess([],0,'RESULT|0|1\n','')
        events=[]
        with patch.object(m.shutil,'which',return_value='/usr/bin/psql'), \
             patch.object(m.subprocess,'run',side_effect=[failed,failed,succeeded]) as run, \
             patch.object(m.time,'sleep') as sleep:
            self.assertEqual(m.run_psql('postgresql://test/db','BEGIN; SELECT 1; COMMIT;',connection_retries=2,retry_events=events),'RESULT|0|1\n')
            self.assertEqual(events,[1,2])
            self.assertEqual([c.args[0] for c in sleep.call_args_list],[1,2])
            self.assertTrue(all(c.kwargs['input']=='BEGIN; SELECT 1; COMMIT;' for c in run.call_args_list))
        for error,expected_calls in [('server closed the connection unexpectedly',3),('ERROR: conflicting token signal identity',1),('ERROR: no space left on device',1)]:
            with patch.object(m.shutil,'which',return_value='/usr/bin/psql'), \
                 patch.object(m.subprocess,'run',return_value=CompletedProcess([],2,'',error)) as run, \
                 patch.object(m.time,'sleep'):
                with self.assertRaises(m.ImporterError):m.run_psql('postgresql://test/db','BEGIN; COMMIT;',connection_retries=2)
                self.assertEqual(run.call_count,expected_calls)

    def test_write_batch_reconnect_and_csv_lifetime(self):
        project=m.Project('sol','ca','pair',60001)
        row=m.candle_row(project,30,'30s','price',{'time':60000,'price':dict(open=1,high=2,low=1,close=2,volume=3)},60001,120000)
        events=[];paths=[]
        def execute(*args,**kwargs):
            sql=kwargs['input'];path=Path(sql.split("FROM '")[1].split("' WITH")[0]);paths.append(path)
            self.assertTrue(path.exists());self.assertIn('BEGIN;',sql);self.assertIn('COMMIT;',sql)
            return CompletedProcess([],2,'','connection reset by peer') if len(paths)==1 else CompletedProcess([],0,'RESULT|1|0\n','')
        with patch.object(m.shutil,'which',return_value='/usr/bin/psql'),patch.object(m.subprocess,'run',side_effect=execute),patch.object(m.time,'sleep'):
            self.assertEqual(m.write_rows('postgresql://test/db',[row,row],batch_size=1,retry_events=events),(2,0))
        self.assertEqual(events,[1]);self.assertEqual(paths[0],paths[1]);self.assertTrue(all(not p.exists() for p in paths))

    def test_resume_reuses_committed_project_without_http_or_database_write(self):
        with tempfile.TemporaryDirectory() as d:
            workbook=Path(d)/'signals.xlsx';report=Path(d)/'previous.jsonl'
            make_xlsx(workbook,[HEADERS,ROW]);now=int(m.time.time()*1000)
            start=dict(kind='start',workbook=str(workbook),now_ms=now,created_within_days=30)
            previous=dict(kind='project',chain='bsc',ca='0xabc',pair_id='pair',created_ms=now-100000,status='partial',errors=[],inserted=5,updated=0,signal_inserted=1,signal_duplicates=0,invalid=1,discarded=0)
            report.write_text(json.dumps(start)+'\n'+json.dumps(previous)+'\n')
            args=m.build_parser().parse_args([str(workbook),'--yes','--resume-report',str(report)])
            with patch.dict(os.environ,{'DATABASE_URL':'postgresql://example/db'}), \
                 patch.object(m,'lookup_projects',return_value=([],[(m.TokenRef('bsc','0xabc',2),'unavailable')])), \
                 patch.object(m,'preflight_database'),patch.object(m,'preflight_signals'), \
                 patch.object(m,'fetch_project') as fetch,patch.object(m,'write_rows') as write:
                self.assertEqual(m.run(args),0);fetch.assert_not_called();write.assert_not_called()
            report.write_text(json.dumps({**start,'workbook_hash':'changed'})+'\n')
            with patch.dict(os.environ,{'DATABASE_URL':'postgresql://example/db'}):
                with self.assertRaisesRegex(m.ImporterError,'checksum'):m.run(args)

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

    def test_expanded_signal_keeps_its_source_and_separate_identity(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'expanded.xlsx'
            expanded = list(ROW); expanded[5] = 'fomo_new_project_expanded'
            make_xlsx(p,[HEADERS,ROW,expanded])
            events = m.read_signals(p, {'bsc'})
            self.assertEqual(len(events), 2)
            self.assertEqual({e['signal_source'] for e in events},
                             {'fomo_new_project', 'fomo_new_project_expanded'})
            project = m.Project('bsc','0xabc','pair',1700000000000)
            self.assertIn("'fomo_new_project_expanded'", m.metadata_sql(project,[events[1]]))

    def test_project_downloads_are_parallel_but_database_writes_are_capped(self):
        with tempfile.TemporaryDirectory() as d:
            workbook = Path(d)/'signals.xlsx'
            make_xlsx(workbook,[HEADERS,ROW])
            args = m.build_parser().parse_args([str(workbook),'--yes','--workers','4','--db-writers','2'])
            now = int(time.time()*1000)
            projects = [m.Project('bsc',f'ca{i}',f'pair{i}',now-100000) for i in range(4)]
            events = [dict(chain='bsc',ca=p.ca,signal_source='fomo_new_project',detail_id=f'd{i}',
                           signal_time=now-100000,source_signal={},provenance=[]) for i,p in enumerate(projects)]
            barrier = threading.Barrier(4)
            lock = threading.Lock()
            active_writes = max_writes = 0

            def fetch(project,*args):
                barrier.wait(timeout=3)
                return m.ProjectResult(project,[])

            def write(*args,**kwargs):
                nonlocal active_writes,max_writes
                with lock:
                    active_writes += 1
                    max_writes = max(max_writes,active_writes)
                time.sleep(.05)
                with lock:
                    active_writes -= 1
                return 0,0

            with patch.dict(os.environ,{'DATABASE_URL':'postgresql://example/db'}), \
                 patch.object(m,'read_tokens',return_value=[m.TokenRef('bsc',p.ca,2) for p in projects]), \
                 patch.object(m,'read_signals',return_value=events), \
                 patch.object(m,'lookup_projects',return_value=(projects,[])), \
                 patch.object(m,'preflight_database'),patch.object(m,'preflight_signals'), \
                 patch.object(m,'fetch_project',side_effect=fetch),patch.object(m,'write_rows',side_effect=write):
                self.assertEqual(m.run(args),0)
            self.assertEqual(max_writes,2)

    def test_single_worker_uses_single_database_writer_by_default(self):
        args = m.build_parser().parse_args(['signals.xlsx','--workers','1'])
        with patch.dict(os.environ,{'DATABASE_URL':'postgresql://example/db'}), \
             patch.object(m,'read_tokens',return_value=[]),patch.object(m,'read_signals',return_value=[]), \
             patch.object(m,'lookup_projects',return_value=([],[])), \
             patch.object(m,'preflight_database'),patch.object(m,'preflight_signals'):
            self.assertEqual(m.run(args),0)

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
                # Real COMMIT succeeds but its acknowledgement is lost: retry must
                # preserve all three tables without duplicate signals or candles.
                execute=m.subprocess.run;attempts=[]
                def lose_reply(*args,**kwargs):
                    result=execute(*args,**kwargs);attempts.append(result)
                    if len(attempts)==1:
                        self.assertEqual(result.returncode,0)
                        return CompletedProcess(result.args,2,'','server closed the connection unexpectedly')
                    return result
                sql=m.build_upsert_sql(p,m.metadata_sql(project,[event])).replace('public.',schema+'.')
                with patch.object(m.subprocess,'run',side_effect=lose_reply),patch.object(m.time,'sleep'):
                    self.assertIn('RESULT|0|1',m.run_psql(url,sql,connection_retries=1))
                self.assertEqual(len(attempts),2)
                self.assertEqual(m.run_psql(url,f'SELECT (SELECT count(*) FROM {schema}.meme_kline),(SELECT count(*) FROM {schema}.token_info),(SELECT count(*) FROM {schema}.token_signal_events);').strip(),'1|1|1')
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
