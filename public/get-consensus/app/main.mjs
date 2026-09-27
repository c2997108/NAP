import { defaults,validateOptions } from './pipeline.mjs';
import { makeZip } from './zip.mjs';
import { workbook } from './workbook.mjs';
import { alignmentViewer,viewerHtml } from './viewer.mjs';
const $=s=>document.querySelector(s),form=$('#options');
let selected=[],worker,result,busy=false,timer,started,viewer,history=[],xlsxUrl;
let generation=0,inputProvenance=null;
const notifyState=()=>window.dispatchEvent(new Event('nap:consensus-state'));
function updateProgress(progress) {
  const value=Math.max($('#consensus-progress').value,Math.min(.99,progress.fraction||0));
  $('#consensus-progress-panel').hidden=false;$('#consensus-progress').value=value;
  $('#consensus-progress-value').textContent=`${Math.floor(value*100)}% · ${progress.phase||'サンプル解析'}`;
  $('#consensus-progress').setAttribute('aria-valuetext',$('#consensus-progress-value').textContent);
  const list=$('#consensus-file-progress');
  for(const file of progress.files||[]) {
    let row=[...list.children].find(row=>row.dataset.sample===file.name);
    if(!row) {
      row=document.createElement('li');row.dataset.sample=file.name;
      const label=document.createElement('span'),bar=document.createElement('progress'),detail=document.createElement('small');
      label.textContent=file.filename;bar.max=1;bar.setAttribute('aria-label',`${file.filename} の解析進捗`);row.append(label,bar,detail);list.append(row);
    }
    row.querySelector('progress').value=file.fraction;
    row.querySelector('small').textContent=`${Math.floor(file.fraction*100)}% · ${file.phase}${file.detail?' · '+file.detail:''}`;
  }
}
function resetProgress() {$('#consensus-progress').value=0;$('#consensus-progress').setAttribute('aria-valuetext','0%');$('#consensus-progress-value').textContent='0%';$('#consensus-file-progress').replaceChildren();$('#consensus-progress-panel').hidden=true;}
function status(text) {$('#status').textContent=text;}
function filesChanged() {
  $('#file-list').replaceChildren();
  selected.forEach(f=>{const li=document.createElement('li');li.textContent=`${f.name}　${(f.size/1024).toFixed(1)} KB`;$('#file-list').append(li);});
  $('#start').disabled=busy || !selected.length || !crossOriginIsolated;
  notifyState();
}
function setBusy(value) {
  busy=value;$('#cancel').disabled=!value;$('#demo').disabled=value;$('#files').disabled=value;form.querySelectorAll('input,select').forEach(i=>i.disabled=value);filesChanged();
  if(value) {started=Date.now();timer=setInterval(()=>$('#elapsed').textContent=`${Math.floor((Date.now()-started)/1000)} 秒`,1000);}
  else {clearInterval(timer);$('#elapsed').textContent=started?`${((Date.now()-started)/1000).toFixed(1)} 秒`:'';}
}
function fail(error) {generation++;worker?.terminate();worker=null;setBusy(false);status(error.name==='AbortError'?'解析を中止しました。':error.message);$('#status').classList.toggle('error',error.name!=='AbortError');}
function download(name,blob) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
function options() {
  const data=new FormData(form),out={};
  for(const [key,value] of Object.entries(defaults)) out[key]=typeof value==='boolean'?data.has(key):typeof value==='number'?Number(data.get(key)):data.get(key);
  return validateOptions(out);
}
async function finish(data,token,provenance) {
  const excel=await workbook(data);
  if(token!==generation)return;
  if(provenance) {data.manifest.nap=provenance;data.files.set('run.json',new Blob([JSON.stringify(data.manifest,null,2)]));}
  result=data;$('#results').hidden=false;
  result.files.set('all.cnt.seq.qual.xlsx',excel);
  if(xlsxUrl) URL.revokeObjectURL(xlsxUrl);
  xlsxUrl=URL.createObjectURL(result.files.get('all.cnt.seq.qual.xlsx'));
  $('#xlsx-download').href=xlsxUrl;$('#xlsx-download').hidden=false;
  const alignments=[{id:'全代表配列',alignment:result.alignment},...result.entries.map(r=>({id:r.id,alignment:r.alignment}))];
  result.files.set('output-consensus-viewer.html',new Blob([viewerHtml(alignments)],{type:'text/html'}));
  $('#metrics').textContent=`${result.samples.length} サンプル　/　${result.manifest.consensuses} コンセンサス　/　${result.manifest.representatives} 代表配列`;
  $('#warnings').textContent=result.manifest.warnings.join('\n');
  const table=$('#counts');table.replaceChildren();
  const head=document.createElement('tr');for(const label of ['代表配列','長さ',...result.names,'合計']) {const th=document.createElement('th');th.textContent=label;head.append(th);} const thead=document.createElement('thead');thead.append(head);table.append(thead);
  const tbody=document.createElement('tbody');
  for(const r of result.rows) {
    const tr=document.createElement('tr'),first=document.createElement('td'),button=document.createElement('button');button.className='sequence-link';button.textContent=r.id;button.onclick=()=>viewer?.select(r.id);first.append(button);tr.append(first);
    for(const n of [r.seq.length,...r.counts,r.total]) {const td=document.createElement('td');td.textContent=Number.isInteger(n)?n.toLocaleString():n.toFixed(3);tr.append(td);} tbody.append(tr);
  }
  table.append(tbody);if(!result.rows.length) $('#warnings').textContent+='\nBLAST の閾値を満たすヒットがありません。コンセンサス配列は保存できます。';
  $('#sample-summary').textContent=result.samples.map(s=>`${s.filename}: ${s.reads} reads → ${s.round1} 初回 / ${s.round2} 統合 / ${s.haplotypes} ハプロタイプ、${s.assigned} reads を割当`).join('\n');
  viewer?.dispose();viewer=alignmentViewer($('#alignment'),alignments);
  $('#outputs').replaceChildren();
  for(const name of ['output-consensus.fastq','output-consensus.fasta','output-all-clusters.max.uc.fasta','all.cnt.txt','all.cnt.seq.qual.xlsx','output-consensus-viewer.html','run.json','pipeline.log']) {
    const b=document.createElement('button');b.className='file-button';b.textContent=name;b.onclick=()=>download(name,result.files.get(name));$('#outputs').append(b);
  }
  $('#consensus-progress').value=1;$('#consensus-progress-value').textContent='100% · 完了';$('#consensus-progress').setAttribute('aria-valuetext','100% · 完了');
  $('#zip').disabled=false;status(`解析完了。${result.files.size} ファイルを保存できます。`);worker?.terminate();worker=null;setBusy(false);
}
function chooseFiles(files,provenance=null) {
  if(busy)throw Error('get-consensusは解析中です。終了または中止してから入力を変更してください。');
  const next=[...files];
  if(next.some(file=>typeof file.name!=='string' || typeof file.size!=='number' || typeof file.stream!=='function' || typeof file.slice!=='function'))throw Error('FASTQのFileオブジェクトが必要です。');
  generation++;selected=next;inputProvenance=provenance?structuredClone(provenance):null;
  resetProgress();
  result=null;viewer?.dispose();viewer=null;$('#results').hidden=true;$('#zip').disabled=true;
  if(xlsxUrl) {URL.revokeObjectURL(xlsxUrl);xlsxUrl=null;}
  $('#xlsx-download').removeAttribute('href');$('#xlsx-download').hidden=true;
  $('#status').classList.remove('error');filesChanged();
  status(provenance?`split-readsから${selected.length} FASTQを受け取りました。解析条件を確認して「解析を開始」を押してください。`:'FASTQを読み込みました。解析条件を確認してください。');
}
$('#files').onchange=e=>chooseFiles(e.target.files);
const drop=$('#drop');
drop.ondragover=e=>{e.preventDefault();if(!busy) drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(busy) return;chooseFiles(e.dataTransfer.files);};
$('#demo').onclick=async()=>{
  try {const demoFiles=await Promise.all(['demo-A.fastq','demo-B.fastq.gz'].map(async name=>{const response=await fetch('./examples/'+name);if(!response.ok) throw Error('デモファイルを取得できません。');return new File([await response.blob()],name);}));chooseFiles(demoFiles);form.elements.strand.value='both';form.elements.adjustDirection.checked=true;status('デモを読み込みました。「解析を開始」で実行できます。');}
  catch(e) {status(e.message);}
};
$('#start').onclick=()=>{
  if(busy)return;
  const token=++generation,provenance=inputProvenance?structuredClone(inputProvenance):null;
  try {
    const settings=options();if(!selected.length) throw Error('FASTQ を選択してください。');
    if(xlsxUrl) {URL.revokeObjectURL(xlsxUrl);xlsxUrl=null;}
    $('#xlsx-download').removeAttribute('href');$('#xlsx-download').hidden=true;
    $('#status').classList.remove('error');$('#results').hidden=true;$('#zip').disabled=true;result=null;history=[];$('#log').textContent='';resetProgress();$('#consensus-progress-panel').hidden=false;setBusy(true);status('解析を開始しています…');
    worker=new Worker(new URL('./pipeline-worker.mjs',import.meta.url),{type:'module'});
    worker.onerror=e=>{if(token===generation)fail(new Error(e.message));};
    worker.onmessage=({data})=>{
      if(token!==generation)return;
      if(data.progress) {
        const p=data.progress,active=p.parallel?.activeSamples;
        updateProgress(p);
        status(p.message+(active?.length?` · ${active.length} サンプル実行中（${active.join(', ')}）`:''));
        history.push(p.message);$('#log').textContent=history.slice(-80).join('\n');$('#log').scrollTop=$('#log').scrollHeight;
      }
      else if(data.error) fail(Object.assign(new Error(data.error.message),{name:data.error.name}));
      else {$('#consensus-progress-value').textContent='99% · Excelと結果画面を生成';status('Excelと結果画面を生成しています…');finish(data.result,token,provenance).catch(error=>{if(token===generation)fail(error);});}
    };
    worker.postMessage({files:selected,options:settings});
  } catch(e) {fail(e);}
};
$('#cancel').onclick=()=>{worker?.postMessage({cancel:true});fail(new DOMException('Cancelled','AbortError'));};
$('#zip').onclick=async()=>{
  const button=$('#zip');button.disabled=true;button.textContent='ZIP を作成中…';
  try {download('get-consensus-results.zip',await makeZip([...result.files].map(([name,blob])=>({name,blob}))));}
  catch(e) {status(e.message);}finally {button.disabled=false;button.textContent='すべて ZIP で保存';}
};
if(!crossOriginIsolated) {status('解析環境の準備が完了していません。HTTPS または npm start でNAPを開き、ページを再読み込みしてください。');$('#status').classList.add('error');}
filesChanged();window.getConsensus={get result(){return result;},get busy(){return busy;},
  get inputs(){return selected.slice();},
  get state(){return {busy,files:selected.map(file=>({name:file.name,size:file.size})),provenance:inputProvenance};},
  setFiles(files,provenance=null){chooseFiles(files,provenance);$('#files').value='';return selected.map(file=>file.name);},
};
window.napConsensus=window.getConsensus;notifyState();
for(const link of document.querySelectorAll('.notes a')) {link.target='_blank';link.rel='noopener';}
