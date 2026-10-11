import { selectFastqFiles } from './shared/fastq-selection.mjs';
import { startMemoryMonitor } from './shared/memory-monitor.mjs';

const $=id=>document.getElementById(id);
const appVersion=$('app-version').dataset.version;
const stages=['split-reads','get-consensus','annotation'];
const splitFrame=$('split-frame'),consensusFrame=$('consensus-frame'),annotationFrame=$('annotation-frame');
const frames={'split-reads':splitFrame,'get-consensus':consensusFrame,annotation:annotationFrame};
const stageActions={};
const stageApis={'split-reads':'napSplit','get-consensus':'napConsensus',annotation:'napAnnotation'};
const retainedResults=stages.map(name=>({name,bytes:0}));
let active='split-reads',signature='',selected=new Set(),transferToken=0,transferring=false;
let outputFiles=[],visibleFiles=[];
const memoryMonitor=startMemoryMonitor({getResults:()=>retainedResults});
const outputRows=new Map();
const filterInputs=['sample-filter','min-reads-filter','min-length-filter','max-length-filter'].map($);
const selectedFiles=()=>visibleFiles.filter(file=>selected.has(file.name));
const split=()=>splitFrame.contentWindow.napSplit;
const consensus=()=>consensusFrame.contentWindow.napConsensus;
const annotation=()=>annotationFrame.contentWindow.napAnnotation;
const size=bytes=>bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1048576).toFixed(1)} MiB`;
function activate(name,focus=false) {
  if(!stages.includes(name))name='split-reads';active=name;
  for(const stage of stages) {
    const button=$(`tab-${stage}`),chosen=stage===name;
    button.setAttribute('aria-selected',String(chosen));button.tabIndex=chosen?0:-1;
    $(`panel-${stage}`).hidden=!chosen;
  }
  history.replaceState(null,'',`#${name}`);
  if(focus)$(`tab-${name}`).focus();
  requestAnimationFrame(()=>resize(frames[name]));
}
function resize(frame) {
  const body=frame.contentDocument?.body;
  if(!body || frame.closest('[role=tabpanel]').hidden)return;
  frame.style.height=`${Math.max(500,Math.ceil(body.getBoundingClientRect().height)+8)}px`;
}
for(const stage of stages) {
  $(`tab-${stage}`).onclick=()=>activate(stage);
  $(`tab-${stage}`).onkeydown=event=>{
    let target;
    if(['ArrowLeft','ArrowRight'].includes(event.key))target=stages[(stages.indexOf(stage)+(event.key==='ArrowRight'?1:stages.length-1))%stages.length];
    if(event.key==='Home')target=stages[0];if(event.key==='End')target=stages[1];
    if(target) {event.preventDefault();activate(target,true);}
  };
}
window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
function updateControls() {
  const splitState=split()?.state,consensusState=consensus()?.state,annotationState=annotation()?.state;
  [splitState,consensusState,annotationState].forEach((state,index)=>{retainedResults[index].bytes=state?.resultBytes || 0;});
  const count=splitState?.files.length||0;
  const chosen=selectedFiles().length;
  $('selection-count').textContent=`${chosen} ファイルを受け渡し`;
  $('transfer-selected').disabled=transferring || !chosen || !splitState || splitState.busy || !consensusState || consensusState.busy;
  if(stageActions['open-consensus'])stageActions['open-consensus'].disabled=!count;
  if(stageActions['open-annotation'])stageActions['open-annotation'].disabled=!consensusState?.table || consensusState.busy;
  $('transfer-consensus').disabled=!consensusState?.table || consensusState.busy || !annotationState || annotationState.busy;
  $('consensus-output-summary').textContent=consensusState?.table?`${consensusState.table.name} · ${consensusState.table.representatives} 代表配列 · ${consensusState.table.samples} サンプル`:'get-consensusを実行すると、ここから集計表を渡せます。';
  for(const control of $('handoff-files').querySelectorAll('input,button,select'))control.disabled=transferring;
  $('select-all').disabled=transferring || !visibleFiles.length;
  $('select-none').disabled=transferring || !selected.size;
  const jobs=[splitState?.busy?'split-reads処理中':'',consensusState?.busy?'get-consensus解析中':'',annotationState?.busy?'分類解析中':''].filter(Boolean);
  $('workspace-status').textContent=jobs.length?jobs.join(' · '):count?`${count} サンプルの分割結果`:'入力待ち';
  memoryMonitor.refresh();
}
function refreshSelection() {
  let error='';
  try {
    const invalid=filterInputs.find(input=>!input.validity.valid);
    if(invalid)throw Error(invalid.id==='min-reads-filter'?'最低リード数には0以上の整数を入力してください。':'平均リード長には0以上の数値を入力してください。');
    const number=id=>$(id).value===''?null:$(id).valueAsNumber;
    visibleFiles=selectFastqFiles(outputFiles,{sample:$('sample-filter').value,minReads:number('min-reads-filter')??0,
      minMeanLength:number('min-length-filter'),maxMeanLength:number('max-length-filter'),sort:$('sample-sort').value});
  } catch(reason) {error=reason.message;visibleFiles=[];}
  for(const row of outputRows.values())row.hidden=true;
  for(const file of visibleFiles) {const row=outputRows.get(file.name);row.hidden=false;$('split-output-list').append(row);}
  $('selection-summary').classList.toggle('error',!!error);
  $('selection-summary').textContent=error || `${visibleFiles.length} / ${outputFiles.length} 件を表示。表示中のチェック済みFASTQだけを、この順序で渡します。平均長はプライマー除去後のリード長です。`;
  $('selection-empty').hidden=!!error || !!visibleFiles.length;
  updateControls();
}
function refreshOutputs() {
  const state=split()?.state;if(!state)return;
  const next=JSON.stringify([state.revision,state.files]);
  if(next!==signature) {
    signature=next;transferToken++;transferring=false;
    outputFiles=state.files;outputRows.clear();
    selected=new Set(state.files.map(file=>file.name));
    const table=$('split-output-list');table.replaceChildren();
    for(const file of state.files) {
      const row=document.createElement('tr');row.dataset.sample=file.sample.toLowerCase();row.dataset.outputName=file.name;
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
      checkbox.setAttribute('aria-label',`${file.sample}.fq`);checkbox.dataset.outputName=file.name;
      checkbox.onchange=()=>{if(checkbox.checked)selected.add(file.name);else selected.delete(file.name);updateControls();};
      const choice=document.createElement('td');choice.append(checkbox);
      const label=document.createElement('td'),sample=document.createElement('span'),filename=document.createElement('small');
      sample.textContent=file.sample;filename.textContent=file.name.split('/').at(-1);label.append(sample,filename);
      const reads=document.createElement('td');reads.textContent=file.reads.toLocaleString();
      const mean=document.createElement('td');mean.textContent=Number.isFinite(file.meanLength)?file.meanLength.toLocaleString('ja-JP',{maximumFractionDigits:2}):'—';
      const bytes=document.createElement('td');bytes.textContent=size(file.size);row.append(choice,label,reads,mean,bytes);table.append(row);outputRows.set(file.name,row);
    }
    $('handoff-empty').hidden=!!state.files.length;$('handoff-files').hidden=!state.files.length;
    $('output-count').hidden=!state.files.length;$('output-count').textContent=String(state.files.length);
    $('transfer-status').classList.remove('error');
    $('transfer-status').textContent=state.files.length?'必要なFASTQを選び、get-consensusに渡してください。解析は自動では開始しません。':'分割結果を待っています。保存済みFASTQを下の入力欄から読み込むこともできます。';
    refreshSelection();
  }
  updateControls();
}
for(const input of filterInputs)input.oninput=refreshSelection;
$('sample-sort').onchange=refreshSelection;
$('reset-filters').onclick=()=>{for(const input of filterInputs)input.value='';$('sample-sort').value='sample-asc';refreshSelection();};
$('select-all').onclick=()=>{
  for(const file of visibleFiles) {selected.add(file.name);outputRows.get(file.name).querySelector('input').checked=true;}updateControls();
};
$('select-none').onclick=()=>{
  selected.clear();for(const row of outputRows.values())row.querySelector('input').checked=false;updateControls();
};
const openConsensus=()=>{activate('get-consensus');window.scrollTo({top:0,behavior:'smooth'});};
$('transfer-selected').onclick=async()=>{
  const state=split()?.state;if(!state || consensus()?.state.busy || transferring || !selectedFiles().length)return;
  const token=++transferToken;transferring=true;updateControls();
  $('transfer-status').classList.remove('error');$('transfer-status').textContent='選択したFASTQを受け渡しています…';
  try {
    const names=selectedFiles().map(file=>file.name);
    const exported=await split().exportFastq(names,state.revision);
    if(token!==transferToken)return;
    consensus().setFiles(exported.files,{application:'NAP',version:appVersion,...exported.provenance});
    $('transfer-status').textContent=`${exported.files.length} FASTQを読み込みました。下の解析条件を確認して「解析を開始」を押してください。`;
    activate('get-consensus');
  } catch(error) {if(token===transferToken) {$('transfer-status').textContent=error.message;$('transfer-status').classList.add('error');}}
  finally {if(token===transferToken) {transferring=false;updateControls();}}
};
const transferConsensus=()=>{
  try {
    const exported=consensus().exportTable(consensus().state.revision);
    annotation().setTable(exported.file,exported.provenance);
    $('annotation-transfer-status').textContent='集計表を受け取りました。参照DBと条件を確認して「分類解析を開始」を押してください。';
    $('annotation-transfer-status').classList.remove('error');activate('annotation');
  } catch(error) {$('annotation-transfer-status').textContent=error.message;$('annotation-transfer-status').classList.add('error');}
};
$('transfer-consensus').onclick=transferConsensus;
for(const [frame,event,refresh,actionId,onNext] of [[splitFrame,'nap:split-state',refreshOutputs,'open-consensus',openConsensus],[consensusFrame,'nap:consensus-state',updateControls,'open-annotation',transferConsensus],[annotationFrame,'nap:annotation-state',updateControls]]) {
  const connect=()=>{
    if(!frame.contentWindow.napSplit && !frame.contentWindow.napConsensus && !frame.contentWindow.napAnnotation) {
      frame.contentWindow.addEventListener('nap:ready',connect,{once:true});updateControls();return;
    }
    if(frame.contentDocument.body.dataset.napConnected)return;
    frame.contentDocument.body.dataset.napConnected='true';
    // Keep the handoff beside the engine's run controls. Standalone engines
    // leave this action hidden because there is no next tab to open.
    if(actionId) {
      const button=frame.contentDocument.getElementById(actionId);
      stageActions[actionId]=button;button.hidden=false;button.onclick=onNext;
    }
    const doc=frame.contentDocument,panel=doc.importNode($('memory-panel-template').content.firstElementChild,true);
    doc.querySelector(frame===splitFrame?'.split-run-actions':'.run-panel').before(panel);
    memoryMonitor.addPanel(panel);
    frame.contentWindow.addEventListener(event,refresh);
    new ResizeObserver(()=>resize(frame)).observe(frame.contentDocument.body);
    refresh();resize(frame);
  };
  frame.addEventListener('load',connect);connect();
}
activate(location.hash.slice(1));
window.nap={activateTab:activate,
  retainedResultBytes(excludeStage) {
    return stages.reduce((total,stage)=>total+(stage===excludeStage?0:frames[stage].contentWindow[stageApis[stage]]?.state.resultBytes || 0),0);
  },
  get state(){return {activeTab:active,selected:selectedFiles().map(file=>file.name),split:split()?.state,consensus:consensus()?.state,annotation:annotation()?.state};}};
