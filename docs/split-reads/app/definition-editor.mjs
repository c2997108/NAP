import { DefinitionModel, directions, parsePrimerClipboard, isSequenceText } from './definition-model.mjs';
import { isDefinitionName } from './demultiplex-core.mjs';

export function createDefinitionEditor({ getFiles, saveBlob, onAvailabilityChanged = () => {} }) {
  const $ = id => document.getElementById(id), model = new DefinitionModel();
  let mode = 'files', busy = false, loading = false, importToken = 0, matrixSignature = '';
  let importedFiles;
  const warnedCells = new Set();
  let invalidCells = new Map();
  let duplicateCells = new Map(), rendering = false;
  const nameWarning = '名前には半角英数字と - . _ だけを使用できます。*、空白、日本語などは使用できません。';
  const sequenceWarning = '塩基配列には半角アルファベット（A-Z、a-z）だけを使用できます。数字、記号、空白、日本語などは使用できません。';
  const bodies = { Forward: $('forward-primers').querySelector('tbody'), Reverse: $('reverse-primers').querySelector('tbody') };
  function message(text, error = false) { $('definition-status').textContent = text; $('definition-status').classList.toggle('error', error); }
  function cellKey(input) {
    const td = input.closest('td'), row = input.closest('tr');
    return `${row.dataset.primerId || `${td.dataset.forwardId}/${td.dataset.reverseId}`}/${input.dataset.field}`;
  }
  function duplicateNameCells() {
    const groups = { primer: new Map(), sample: new Map() }, cells = new Map(), messages = [];
    const add = (type, name, input) => {
      if (!name || !isDefinitionName(name)) return;
      if (!groups[type].has(name)) groups[type].set(name, []);
      groups[type].get(name).push(input);
    };
    for (const direction of directions) {
      const rows = new Map(model.active(direction).map(row => [row.id, row]));
      for (const input of bodies[direction].querySelectorAll('input[data-field="name"]')) {
        const row = rows.get(input.closest('tr').dataset.primerId);
        if (row) add('primer', model.primerName(direction, row), input);
      }
    }
    const primers = new Map([...model.forward, ...model.reverse].map(row => [row.id, row]));
    for (const input of $('sample-matrix').querySelectorAll('input[data-field="name"]')) {
      const td = input.closest('td'), f = primers.get(td.dataset.forwardId), r = primers.get(td.dataset.reverseId);
      const automatic = isDefinitionName(model.primerName('Forward', f)) && isDefinitionName(model.primerName('Reverse', r)) ? model.sampleName(f, r) : '';
      add('sample', input.value || automatic, input);
    }
    for (const [type, names] of Object.entries(groups)) {
      const duplicates = [...names].filter(([, inputs]) => inputs.length > 1);
      const label = type === 'primer' ? 'プライマー名' : 'サンプル名';
      for (const [name, inputs] of duplicates) for (const input of inputs) cells.set(cellKey(input), { name, warning: `${label}が重複しています: ${name}（${inputs.length} セル）。別の名前に変更してください。` });
      if (duplicates.length) messages.push(`${label}が重複しています: ${duplicates.slice(0, 8).map(([name]) => name).join('、')}${duplicates.length > 8 ? ` ほか ${duplicates.length - 8} 件` : ''}。オレンジ色のセルを修正してください。`);
    }
    const notice = $('definition-duplicate-warning'), text = messages.join('\n');
    if (notice.textContent !== text) notice.textContent = text;
    notice.hidden = !messages.length;
    return cells;
  }
  function validateCells(warn, checkDuplicates) {
    if (checkDuplicates) duplicateCells = duplicateNameCells();
    const invalid = new Map();
    for (const input of $('definition-editor').querySelectorAll('input[data-field="name"], input[data-field="sequence"]')) {
      const td = input.closest('td'), keyBase = cellKey(input);
      const sequence = input.dataset.field === 'sequence';
      const bad = input.value !== '' && !(sequence ? isSequenceText(input.value) : isDefinitionName(input.value));
      const duplicate = !bad && duplicateCells.get(keyBase);
      const warning = bad ? (sequence ? sequenceWarning : nameWarning) : duplicate?.warning;
      td.classList.toggle('input-invalid', bad);
      td.classList.toggle('input-duplicate', Boolean(duplicate));
      input.setCustomValidity(warning || '');
      if (warning) {
        input.setAttribute('aria-invalid', 'true'); input.title = warning;
        const label = input.getAttribute('aria-label') || [td.dataset.forwardId, td.dataset.reverseId].map(id => $(`matrix-header-${id}`).textContent).join(' × ') + ' サンプル名';
        const key = `${keyBase}/${bad ? 'character' : `duplicate:${duplicate.name}`}`;
        invalid.set(key, { input, label, warning, duplicate: Boolean(duplicate) });
      } else { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); }
    }
    invalidCells = invalid;
    for (const key of warnedCells) if (!invalid.has(key)) warnedCells.delete(key);
    const newlyInvalid = [...invalid].filter(([key, cell]) => !warnedCells.has(key) && (checkDuplicates || !cell.duplicate));
    if (warn && newlyInvalid.length) {
      // Paint the warning cells before showing one popup for the whole edit/paste.
      requestAnimationFrame(() => setTimeout(() => {
        const remaining = newlyInvalid.map(([key]) => ({ key, ...invalidCells.get(key) })).filter(({ key, input }) => input && !warnedCells.has(key));
        if (!remaining.length || mode !== 'table') return;
        remaining.forEach(({ key }) => warnedCells.add(key));
        const labels = remaining.slice(0, 8).map(({ label }) => label).join('\n');
        const warnings = [...new Set(remaining.map(({ warning }) => warning))].join('\n');
        window.alert(`入力内容を確認してください。\n\n${warnings}\n\n${labels}${remaining.length > 8 ? `\nほか ${remaining.length - 8} セル` : ''}\n\n警告が表示されたセルを修正してください。`);
      }, 0));
    }
  }
  function availability() {
    $('definition-fields').disabled = busy || loading;
    for (const id of ['mode-files', 'mode-table']) $(id).disabled = busy || loading;
    onAvailabilityChanged();
  }
  function setMode(value, focus = false) {
    if (!['files', 'table'].includes(value)) throw Error('入力方法が不正です。');
    mode = value;
    $('definition-files').hidden = mode !== 'files'; $('definition-editor').hidden = mode !== 'table'; $('definition-table-info').hidden = mode !== 'table';
    for (const key of ['files', 'table']) {
      const button = $(`mode-${key}`), selected = mode === key;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    if (focus) $(`mode-${mode}`).focus();
    refresh();
  }
  function scrollToTable() {
    // Let the containing iframe resize after the editor becomes visible.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mode !== 'table') return;
      $('definition-editor').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }));
  }
  async function selectMode(value, focus = false, scroll = false) {
    if (busy || loading) return;
    const { primerFile, sampleFile } = getFiles();
    setMode(value, focus);
    if (value === 'table' && primerFile && (primerFile !== importedFiles?.primerFile || sampleFile !== importedFiles?.sampleFile)) {
      await importFiles();
      if (mode !== value) return;
      if (focus) $(`mode-${value}`).focus();
    }
    if (value === 'table' && scroll) scrollToTable();
  }
  for (const value of ['files', 'table']) {
    $(`mode-${value}`).onclick = () => selectMode(value, false, true);
    $(`mode-${value}`).onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); if (busy || loading) return;
      void selectMode(event.key === 'Home' ? 'files' : event.key === 'End' ? 'table' : mode === 'files' ? 'table' : 'files', true);
    };
  }
  function primerRows(direction) {
    const body = bodies[direction]; body.replaceChildren();
    for (const [index, row] of model.rows(direction).entries()) {
      const tr = document.createElement('tr'); tr.dataset.primerId = row.id;
      const name = document.createElement('input'); name.value = row.name; name.dataset.field = 'name'; name.placeholder = direction === 'Forward' ? `F${index + 1}` : `R${index + 1}`;
      name.pattern = '[A-Za-z0-9_.\\-]+';
      name.setAttribute('aria-label', `${direction} ${index + 1} 配列名`);
      const sequence = document.createElement('input'); sequence.value = row.sequence; sequence.dataset.field = 'sequence'; sequence.placeholder = 'ACGT…'; sequence.spellcheck = false;
      sequence.pattern = '[A-Za-z]+';
      sequence.setAttribute('aria-label', `${direction} ${index + 1} 塩基配列`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.dataset.removeId = row.id;
      remove.setAttribute('aria-label', `${direction} ${index + 1} 行を削除`);
      const labelCell = document.createElement('td'), nameCell = document.createElement('div'), sequenceCell = document.createElement('td');
      nameCell.className = 'primer-name-cell'; nameCell.append(remove, name); labelCell.append(nameCell); sequenceCell.append(sequence); tr.append(labelCell, sequenceCell); body.append(tr);
    }
  }
  function matrix() {
    const forward = model.active('Forward'), reverse = model.active('Reverse');
    const signature = JSON.stringify([forward.map(row => row.id), reverse.map(row => row.id)]);
    const hasPairs = !!forward.length && !!reverse.length;
    $('matrix-empty').hidden = hasPairs; $('sample-matrix').hidden = !hasPairs;
    if (signature !== matrixSignature) {
      matrixSignature = signature;
      const head = $('sample-matrix').querySelector('thead'), body = $('sample-matrix').querySelector('tbody'); head.replaceChildren(); body.replaceChildren();
      const headings = document.createElement('tr'), corner = document.createElement('th'); corner.textContent = 'Forward ↓ / Reverse →'; headings.append(corner);
      for (const row of reverse) {
        const th = document.createElement('th'); th.scope = 'col'; th.id = `matrix-header-${row.id}`; headings.append(th);
      }
      head.append(headings);
      for (const f of forward) {
        const tr = document.createElement('tr'), th = document.createElement('th'); th.scope = 'row'; th.id = `matrix-header-${f.id}`; tr.append(th);
        for (const r of reverse) {
          const td = document.createElement('td'); td.dataset.forwardId = f.id; td.dataset.reverseId = r.id;
          const cell = model.cell(f.id, r.id), input = document.createElement('input'); input.dataset.field = 'name'; input.value = cell.name; input.autocomplete = 'off'; input.pattern = '[A-Za-z0-9_.\\-]+';
          input.setAttribute('aria-labelledby', `matrix-header-${f.id} matrix-header-${r.id} matrix-name-label`); td.append(input);
          const lengths = document.createElement('div'); lengths.className = 'cell-lengths';
          for (const [field, label] of [['min', '最小長'], ['max', '最大長']]) {
            const l = document.createElement('label'), length = document.createElement('input'); l.textContent = label;
            length.type = 'number'; length.min = '0'; length.step = '1'; length.dataset.field = field; length.value = cell[field]; length.placeholder = '制限なし';
            length.setAttribute('aria-labelledby', `matrix-header-${f.id} matrix-header-${r.id} matrix-${field}-label`);
            l.append(length); lengths.append(l);
          }
          td.append(lengths); tr.append(td);
        }
        body.append(tr);
      }
    }
    for (const [direction, rows] of [['Forward', forward], ['Reverse', reverse]]) for (const row of rows) {
      $(`matrix-header-${row.id}`).textContent = model.primerName(direction, row);
    }
    for (const td of $('sample-matrix').querySelectorAll('td[data-forward-id]')) {
      const f = forward.find(row => row.id === td.dataset.forwardId), r = reverse.find(row => row.id === td.dataset.reverseId);
      td.querySelector('input[data-field="name"]').placeholder = model.emptyNames === 'generate' ? `s_${model.primerName('Forward', f)}_${model.primerName('Reverse', r)}` : '空欄は出力しない';
    }
  }
  function refresh(warn = false, checkDuplicates = false) {
    const previousRendering = rendering; rendering = true;
    try { matrix(); } finally { rendering = previousRendering; }
    validateCells(warn, checkDuplicates);
    let fasta = '', samples = '', error;
    try { fasta = model.fasta(); } catch (e) { error = e.message; }
    if (!error) try { samples = model.sampleText(); } catch (e) { error = e.message; }
    if (error?.includes('重複') && !checkDuplicates) error = $('definition-duplicate-warning').hidden ? '名前の編集中です。入力欄を離れたときに確認します。' : $('definition-duplicate-warning').textContent;
    $('primer-preview').value = fasta; $('sample-preview').value = samples;
    const forwardIds = new Set(model.active('Forward').map(row => row.id)), reverseIds = new Set(model.active('Reverse').map(row => row.id));
    const count = [...model.cells.values()].filter(cell => forwardIds.has(cell.forwardId) && reverseIds.has(cell.reverseId) && (cell.name.trim() || model.emptyNames === 'generate')).length;
    const text = `${model.active('Forward').length} Forward / ${model.active('Reverse').length} Reverse / ${count} サンプル`;
    $('definition-table-info').textContent = `入力表を使用: ${text}。分割時に表の最新内容を読み込みます。`;
    message(error || `${text} · ファイル保存・分割に使用できます。`);
  }
  function redraw(warn = false, checkDuplicates = true) {
    rendering = true;
    try { for (const direction of directions) primerRows(direction); matrixSignature = ''; refresh(warn, checkDuplicates); }
    finally { rendering = false; }
  }
  $('definition-editor').addEventListener('focusout', event => {
    if (rendering || busy || loading || !event.target.matches('input[data-field="name"], input[data-field="sequence"]')) return;
    refresh(true, true);
  });
  $('definition-editor').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || busy || loading) return;
    const input = event.target;
    if (!input.matches('tbody input[data-field]')) return;
    const table = input.closest('table'), tr = input.closest('tr');
    const direction = directions.find(value => table.id === `${value.toLowerCase()}-primers`);
    if (!direction && table.id !== 'sample-matrix') return;
    const field = direction ? 'name' : input.dataset.field;
    event.preventDefault();
    if (event.repeat) return;
    const next = tr.nextElementSibling;
    if (next) {
      const cell = direction ? next : next.cells[input.closest('td').cellIndex];
      cell.querySelector(`input[data-field="${field}"]`).focus();
      return;
    }
    // Commit the edit through a real blur before rebuilding the tables.
    input.blur();
    if (direction) {
      const row = model.addPrimer(direction); redraw(false, false);
      bodies[direction].querySelector(`tr[data-primer-id="${row.id}"] input[data-field="${field}"]`).focus();
    } else {
      // Each sample row needs a Forward primer; reuse an empty draft if present.
      const row = model.rows('Forward').find(row => !row.name && !row.sequence) || model.addPrimer('Forward');
      redraw(false, false);
      bodies.Forward.querySelector(`tr[data-primer-id="${row.id}"] input[data-field="name"]`).focus();
      message('サンプル表の行を追加するには、このForwardプライマーの塩基配列を入力してください。配列名は空欄でもかまいません。');
    }
  });
  for (const direction of directions) {
    const body = bodies[direction];
    body.oninput = event => {
      const input = event.target.closest('input[data-field]'); if (!input || busy || loading) return;
      const row = model.rows(direction).find(row => row.id === input.closest('tr').dataset.primerId);
      row[input.dataset.field] = input.value; refresh(!event.isComposing);
    };
    body.addEventListener('compositionend', () => { if (!busy && !loading) refresh(true); });
    body.onclick = event => {
      const button = event.target.closest('button[data-remove-id]'); if (!button || busy || loading) return;
      model.removePrimer(direction, button.dataset.removeId); redraw();
    };
    body.onpaste = event => {
      const input = event.target.closest('input[data-field]'), text = event.clipboardData?.getData('text/plain');
      if (!input || busy || loading || !text) return;
      const field = input.dataset.field, { rows, column } = parsePrimerClipboard(text, field);
      if (!/[\t\r\n]/.test(text) && !(column === 0 && rows[0]?.length === 2)) return;
      event.preventDefault();
      const rowId = input.closest('tr').dataset.primerId;
      model.pastePrimers(direction, rowId, field, text); redraw(true, false);
      body.querySelector(`tr[data-primer-id="${rowId}"] input[data-field="${field}"]`).focus();
    };
    $(`add-${direction.toLowerCase()}`).onclick = () => {
      if (busy || loading) return; const row = model.addPrimer(direction); redraw();
      body.querySelector(`tr[data-primer-id="${row.id}"] input`).focus();
    };
  }
  $('sample-matrix').oninput = event => {
    const input = event.target.closest('input[data-field]'); if (!input || busy || loading) return;
    const td = input.closest('td'), cell = model.cell(td.dataset.forwardId, td.dataset.reverseId);
    cell[input.dataset.field] = input.value;
    if (input.dataset.field !== 'name') cell.customLength = true;
    refresh(!event.isComposing);
  };
  $('sample-matrix').addEventListener('compositionend', () => { if (!busy && !loading) refresh(true); });
  $('sample-matrix').onpaste = event => {
    const input = event.target.closest('input[data-field="name"]'), text = event.clipboardData?.getData('text/plain');
    if (!input || busy || loading || !/[\t\r\n]/.test(text || '')) return;
    event.preventDefault(); const td = input.closest('td');
    try {
      const { forwardId, reverseId } = td.dataset;
      model.pasteSamples(forwardId, reverseId, text); matrixSignature = ''; refresh(true);
      $('sample-matrix').querySelector(`td[data-forward-id="${forwardId}"][data-reverse-id="${reverseId}"] input[data-field="name"]`).focus();
    }
    catch (error) { message(error.message, true); }
  };
  function lengths(overwrite = false) {
    model.setDefaults($('default-min-length').value, $('default-max-length').value, overwrite);
    for (const td of $('sample-matrix').querySelectorAll('td[data-forward-id]')) {
      const cell = model.cell(td.dataset.forwardId, td.dataset.reverseId);
      for (const field of ['min', 'max']) td.querySelector(`input[data-field="${field}"]`).value = cell[field];
    }
    refresh();
  }
  $('empty-sample-names').onchange = () => { model.emptyNames = $('empty-sample-names').value; refresh(true, true); };
  for (const id of ['default-min-length', 'default-max-length']) $(id).oninput = () => lengths();
  $('apply-default-lengths').onclick = () => lengths(true);
  $('show-cell-lengths').onchange = () => $('sample-matrix').classList.toggle('show-cell-lengths', $('show-cell-lengths').checked);
  for (const [id, filename, content] of [['save-primer-fasta', 'primer.fasta', () => model.fasta()], ['save-sample-text', 'sample.txt', () => model.sampleText()]]) $(id).onclick = async () => {
    if (busy || loading) return;
    try { await saveBlob(new Blob([content()], { type: 'text/plain;charset=utf-8' }), filename); message(`${filename} を保存しました。`); }
    catch (error) { message(error.message, true); }
  };
  async function importFiles({ openTable = false } = {}) {
    if (busy || loading) return;
    const token = ++importToken; loading = true; availability(); message('ファイルを読み込んでいます…');
    try {
      const { primerFile, sampleFile } = getFiles();
      if (!primerFile) throw Error('「ファイルを選択」で primer FASTA を指定してから、表に読み込んでください。');
      const [primerText, sampleText] = await Promise.all([primerFile.text(), sampleFile ? sampleFile.text() : '']);
      if (token !== importToken) return;
      const { forwardDefaults } = model.import(primerText, sampleText); redraw();
      importedFiles = { primerFile, sampleFile };
      const individual = [...model.cells.values()].some(cell => cell.customLength);
      $('show-cell-lengths').checked = individual; $('sample-matrix').classList.toggle('show-cell-lengths', individual);
      if (openTable) { setMode('table'); scrollToTable(); }
      const fallback = forwardDefaults.length ? ` 方向を判定できない${forwardDefaults.length}配列をForwardに配置しました: ${forwardDefaults.slice(0, 8).join('、')}${forwardDefaults.length > 8 ? '…' : ''}。` : '';
      message(`ファイルを表に読み込みました。名前・配列・サンプル名を編集できます。${fallback}`);
      return { success: true };
    } catch (error) {
      if (token === importToken) { message(error.message, true); return { success: false, error: error.message }; }
    }
    finally { if (token === importToken) { loading = false; availability(); } }
  }
  $('import-definitions').onclick = () => importFiles();
  redraw();
  return {
    get mode() { return mode; }, get loading() { return loading; },
    setMode, importFiles,
    setBusy(value) { busy = value; availability(); },
    export() { if (loading) throw Error('入力ファイルの読込み完了を待ってください。'); return model.export(); },
    cancelImport() { importToken++; loading = false; availability(); },
  };
}
