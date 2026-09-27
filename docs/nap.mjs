const $=id=>document.getElementById(id);
const stages=['split-reads','get-consensus'];
const splitFrame=$('split-frame'),consensusFrame=$('consensus-frame');
let active='split-reads',signature='',selected=new Set(),transferToken=0,transferring=false;
const split=()=>splitFrame.contentWindow.napSplit;
const consensus=()=>consensusFrame.contentWindow.napConsensus;
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
  requestAnimationFrame(()=>resize(name==='split-reads'?splitFrame:consensusFrame));
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
    if(['ArrowLeft','ArrowRight'].includes(event.key))target=stages[1-stages.indexOf(stage)];
    if(event.key==='Home')target=stages[0];if(event.key==='End')target=stages[1];
    if(target) {event.preventDefault();activate(target,true);}
  };
}
window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
function updateControls() {
  const splitState=split()?.state,consensusState=consensus()?.state;
  const count=splitState?.files.length||0;
  $('selection-count').textContent=`${selected.size} / ${count} ファイル選択`;
  $('transfer-selected').disabled=transferring || !selected.size || !splitState || splitState.busy || !consensusState || consensusState.busy;
  $('open-consensus').disabled=!count;
  for(const control of $('handoff-files').querySelectorAll('input,button'))control.disabled=transferring;
  const jobs=[splitState?.busy?'split-reads処理中':'',consensusState?.busy?'get-consensus解析中':''].filter(Boolean);
  $('workspace-status').textContent=jobs.length?jobs.join(' · '):count?`${count} サンプルの分割結果`:'入力待ち';
}
function refreshOutputs() {
  const state=split()?.state;if(!state)return;
  const next=JSON.stringify([state.revision,state.files]);
  if(next!==signature) {
    signature=next;transferToken++;transferring=false;
    selected=new Set(state.files.map(file=>file.name));
    const table=$('split-output-list');table.replaceChildren();
    for(const file of state.files) {
      const row=document.createElement('tr');row.dataset.sample=file.sample.toLowerCase();
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
      checkbox.setAttribute('aria-label',`${file.sample}.fq`);checkbox.dataset.outputName=file.name;
      checkbox.onchange=()=>{if(checkbox.checked)selected.add(file.name);else selected.delete(file.name);updateControls();};
      const choice=document.createElement('td');choice.append(checkbox);
      const label=document.createElement('td'),sample=document.createElement('span'),filename=document.createElement('small');
      sample.textContent=file.sample;filename.textContent=file.name.split('/').at(-1);label.append(sample,filename);
      const reads=document.createElement('td');reads.textContent=file.reads.toLocaleString();
      const bytes=document.createElement('td');bytes.textContent=size(file.size);row.append(choice,label,reads,bytes);table.append(row);
    }
    $('handoff-empty').hidden=!!state.files.length;$('handoff-files').hidden=!state.files.length;
    $('output-count').hidden=!state.files.length;$('output-count').textContent=String(state.files.length);
    $('sample-filter').value='';
    $('transfer-status').classList.remove('error');
    $('transfer-status').textContent=state.files.length?'必要なFASTQを選び、get-consensusに渡してください。解析は自動では開始しません。':'分割結果を待っています。保存済みFASTQを下の入力欄から読み込むこともできます。';
  }
  updateControls();
}
$('sample-filter').oninput=()=>{const term=$('sample-filter').value.toLowerCase();for(const row of $('split-output-list').children)row.hidden=!row.dataset.sample.includes(term);};
for(const [id,checked] of [['select-all',true],['select-none',false]])$(id).onclick=()=>{
  selected.clear();for(const checkbox of $('split-output-list').querySelectorAll('input')) {checkbox.checked=checked;if(checked)selected.add(checkbox.dataset.outputName);}updateControls();
};
$('open-consensus').onclick=()=>{activate('get-consensus');window.scrollTo({top:0,behavior:'smooth'});};
$('transfer-selected').onclick=async()=>{
  const state=split()?.state;if(!state || consensus()?.state.busy || transferring || !selected.size)return;
  const token=++transferToken;transferring=true;updateControls();
  $('transfer-status').classList.remove('error');$('transfer-status').textContent='選択したFASTQを受け渡しています…';
  try {
    const names=state.files.filter(file=>selected.has(file.name)).map(file=>file.name);
    const exported=await split().exportFastq(names,state.revision);
    if(token!==transferToken)return;
    consensus().setFiles(exported.files,{application:'NAP',version:'1.0.0',...exported.provenance});
    $('transfer-status').textContent=`${exported.files.length} FASTQを読み込みました。下の解析条件を確認して「解析を開始」を押してください。`;
    activate('get-consensus');
  } catch(error) {if(token===transferToken) {$('transfer-status').textContent=error.message;$('transfer-status').classList.add('error');}}
  finally {if(token===transferToken) {transferring=false;updateControls();}}
};
for(const [frame,event,refresh] of [[splitFrame,'nap:split-state',refreshOutputs],[consensusFrame,'nap:consensus-state',updateControls]]) {
  const connect=()=>{
    if(!frame.contentWindow.napSplit && !frame.contentWindow.napConsensus) {
      frame.contentWindow.addEventListener('nap:ready',connect,{once:true});updateControls();return;
    }
    if(frame.contentDocument.body.dataset.napConnected)return;
    frame.contentDocument.body.dataset.napConnected='true';
    frame.contentWindow.addEventListener(event,refresh);
    new ResizeObserver(()=>resize(frame)).observe(frame.contentDocument.body);
    refresh();resize(frame);
  };
  frame.addEventListener('load',connect);connect();
}
activate(location.hash.slice(1));
window.nap={activateTab:activate,get state(){return {activeTab:active,selected:[...selected],split:split()?.state,consensus:consensus()?.state};}};
