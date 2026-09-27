export function alignmentViewer(container, alignments) {
  container.replaceChildren();
  const controls=document.createElement('div');controls.className='viewer-controls';
  const select=document.createElement('select'); select.setAttribute('aria-label','アラインメントを選択');
  for(const item of alignments) {const o=document.createElement('option');o.value=item.id;o.textContent=item.id;select.append(o);}
  const zoom=document.createElement('input');zoom.type='range';zoom.min='8';zoom.max='24';zoom.value='13';zoom.setAttribute('aria-label','塩基の表示サイズ');
  const label=document.createElement('label'); label.textContent='差分を強調 ';
  const diff=document.createElement('input');diff.type='checkbox';diff.checked=true;label.append(diff);
  controls.append(select,document.createTextNode('拡大 '),zoom,label);
  const position=document.createElement('input');position.type='range';position.min='0';position.value='0';position.setAttribute('aria-label','アラインメントの開始位置');position.style.width='100%';
  const info=document.createElement('p');info.className='viewer-info';
  const wrap=document.createElement('div');wrap.style.cssText='overflow:auto;max-height:480px;background:#fff;border:1px solid #d9e3df;border-radius:10px;';
  const canvas=document.createElement('canvas');canvas.style.display='block';wrap.append(canvas);container.append(controls,info,position,wrap);
  let records=[], length=0;
  function load() {
    const item=alignments.find(i=>i.id===select.value);if(!item) return;
    records=[];
    for(const line of item.alignment.split(/\r?\n/)) {
      if(line.startsWith('>')) records.push({id:line.slice(1),seq:''});else if(line.trim() && records.length) records.at(-1).seq+=line.trim().toUpperCase();
    }
    length=records[0]?.seq.length||0;position.max=String(Math.max(0,length-1));position.value='0';draw();
  }
  function draw() {
    if(!records.length) return;
    const size=Number(zoom.value),names=200,row=23,start=Number(position.value),width=Math.max(340,wrap.clientWidth||900),visible=Math.max(1,Math.floor((width-names)/size));
    const height=Math.min(32760,(records.length+1)*row),dpr=devicePixelRatio||1;
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.width=width+'px';canvas.style.height=height+'px';
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.font='12px ui-monospace,monospace';
    ctx.fillStyle='#547068';
    for(let p=start;p<Math.min(length,start+visible);p++) if(p%10===0) ctx.fillText(String(p+1),names+(p-start)*size,16);
    const colors={A:'#d4eadb',C:'#d2e7fa',G:'#fff1c4',T:'#f7d6d4',U:'#f7d6d4','-':'#eef1f0'};
    records.forEach((r,i)=>{
      const y=(i+1)*row;if(y>height) return;
      ctx.fillStyle=i===0?'#173e32':'#567168';ctx.fillText(r.id.length>25?r.id.slice(0,24)+'…':r.id,8,y+16);
      for(let p=start;p<Math.min(length,start+visible);p++) {
        const b=r.seq[p],x=names+(p-start)*size,same=i>0 && b===records[0].seq[p];
        ctx.fillStyle=diff.checked && same?'#f4f6f5':colors[b]||'#e5def3';ctx.fillRect(x,y,size-1,row-1);
        ctx.fillStyle=diff.checked && same?'#a7b6b1':'#25453b';ctx.fillText(b||'',x+2,y+16);
      }
    });
    info.textContent=`${records.length} 配列 · ${length.toLocaleString()} 列 · 表示 ${start+1}–${Math.min(length,start+visible)}　A 緑 / C 青 / G 黄 / T 赤`;
  }
  select.onchange=load;zoom.oninput=draw;position.oninput=draw;diff.onchange=draw;
  const observer=new ResizeObserver(draw);observer.observe(wrap);load();
  return {select:id=>{select.value=id;load();},dispose:()=>observer.disconnect()};
}
export function viewerHtml(alignments) {
  const payload=JSON.stringify(alignments).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>get-consensus alignment viewer</title><style>body{font-family:system-ui;background:#f5f8f6;color:#173e32;margin:32px}select{max-width:60%;padding:8px}input,select{margin:6px}.viewer-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.viewer-info{font-size:13px}</style><h1>Consensus alignments</h1><p>ローカルで開けるアラインメントビューアー</p><div id="viewer"></div><script>(${alignmentViewer.toString()})(document.querySelector('#viewer'),${payload});</script></html>`;
}
