import { makeZip } from './zip.mjs';
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
function column(i) {let s='';for(i++;i;i=Math.floor((i-1)/26)) s=String.fromCharCode(65+(i-1)%26)+s;return s;}
export async function workbook(result) {
  const table=[['id','seq','qual',...result.names],...result.rows.map(r=>[r.id,r.seq,r.qual,...r.counts])];
  const longCells=table.slice(1).some(row=>row.some(c=>typeof c==='string' && c.length>32767));
  const sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="48" customWidth="1"/><col min="2" max="3" width="28" customWidth="1"/><col min="4" max="'+Math.max(4,table[0].length)+'" width="18" customWidth="1"/></cols><sheetData>'+table.map((row,i)=>`<row r="${i+1}">`+row.map((cell,j)=>{
    const at=`${column(j)}${i+1}`;
    if(typeof cell==='number') return `<c r="${at}"><v>${cell}</v></c>`;
    return `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.length>32767?'[全文は all.cnt.seq.qual.txt を参照]':cell)}</t></is></c>`;
  }).join('')+'</row>').join('')+'</sheetData><autoFilter ref="A1:'+column(table[0].length-1)+table.length+'"/></worksheet>';
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Consensus counts" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheet};
  if(longCells) {result.manifest.warnings.push('Excel のセル上限（32767文字）を超える配列・品質の全文は all.cnt.seq.qual.txt を参照。');result.files.set('run.json',new Blob([JSON.stringify(result.manifest,null,2)]));}
  return new Blob([await makeZip(Object.entries(files).map(([name,text])=>({name,blob:new Blob([text])})))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
