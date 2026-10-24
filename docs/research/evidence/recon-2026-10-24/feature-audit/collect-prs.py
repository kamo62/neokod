from pathlib import Path
import subprocess,json,datetime,csv,time
b=Path('/tmp/neokod-feature-audit-2026-10-24');raw=b/'closed-pr-days';raw.mkdir(exist_ok=True)
start=datetime.date(2026,9,24);end=datetime.date(2026,10,24);rows={};counts=[]
d=start
while d<=end:
 name=str(d);path=raw/(name+'.json')
 if path.exists():data=json.loads(path.read_text())
 else:
  items=[];total=None;page=1
  while total is None or len(items)<total:
   q=f'repo:pingdotgg/t3code is:pr closed:{name}'
   p=subprocess.run(['gh','api','search/issues','--method','GET','-f','q='+q,'-f','per_page=100','-f','page='+str(page)],capture_output=True,text=True)
   if p.returncode:raise RuntimeError(f'GitHub search failed date{name}page{page}; raw errors suppressed')
   result=json.loads(p.stdout);total=result['total_count']
   if result.get('incomplete_results') or total>1000:raise RuntimeError(f'Incomplete date{name}: {total}; subdivide before proceeding')
   batch=result['items'];items+=batch
   if not batch and len(items)<total:raise RuntimeError('Empty incompletepage')
   page+=1;time.sleep(.15)
  data={'date':name,'total_count':total,'items':items,'source':'GitHub search API, closed date inclusive UTC'};path.write_text(json.dumps(data,indent=2))
 counts.append({'date':name,'reported':data['total_count'],'captured':len(data['items'])})
 for r in data['items']:rows[r['number']]=r
 print(name,len(data['items']),flush=True);d+=datetime.timedelta(days=1)
allrows=sorted(rows.values(),key=lambda x:(x['closed_at'],x['number']))
(b/'all-closed-prs.json').write_text(json.dumps(allrows,indent=2))
with (b/'all-closed-prs.csv').open('w') as f:
 w=csv.writer(f);w.writerow(['number','title','closed_at','merged_at','draft','labels','url'])
 for r in allrows:w.writerow([r['number'],r['title'],r['closed_at'],r.get('pull_request',{}).get('merged_at'),r.get('draft'),'; '.join(x['name'] for x in r['labels']),r['html_url']])
(b/'census-receipt.json').write_text(json.dumps({'windowStartInclusive':'2026-09-24T00:00:00Z','windowEndCollectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'dailyCounts':counts,'uniquePRs':len(rows),'duplicates':sum(x['captured'] for x in counts)-len(rows),'rawBodiesRetained':True,'readOnlyUpstream':True},indent=2))
print('COMPLETE',len(rows),flush=True)
