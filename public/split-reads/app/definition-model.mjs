import { parseSamples, validateDefinitionName } from './demultiplex-core.mjs';

export const directions = ['Forward', 'Reverse'];
export const isSequenceText = text => /^[A-Za-z]+$/.test(text);
export const normalizeSequence = text => text.replace(/\s+/g, '').toUpperCase();
export const parseClipboard = text => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(row => row.split('\t'));

export function parsePrimerClipboard(text, field) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  const rows = lines.map(line => {
    const pair = line.trim().match(/^(\S+)\s+(.+)$/);
    if (pair) return [pair[1], pair[2].trim()];
    return line.includes('\t') ? line.split('\t').map(value => value.trim()) : [line.trim()];
  });
  // Keep a single sequence-cell paste in that cell; validate its characters later.
  const pairs = rows.length > 0 && rows.every(row => row.length === 2) && (field === 'name' || rows.length > 1 || text.includes('\t'));
  return { rows: field === 'sequence' && !pairs ? lines.map(line => [line.trim()]) : rows, column: pairs ? 0 : ['name', 'sequence'].indexOf(field) };
}

export class DefinitionModel {
  constructor() {
    this.nextId = 1; this.forward = []; this.reverse = []; this.cells = new Map();
    this.defaults = { min: '', max: '' }; this.emptyNames = 'generate';
    this.addPrimer('Forward'); this.addPrimer('Reverse');
  }
  rows(direction) {
    if (!directions.includes(direction)) throw Error('Forward または Reverse を指定してください。');
    return direction === 'Forward' ? this.forward : this.reverse;
  }
  addPrimer(direction, values = {}) {
    const row = { id: `primer-${this.nextId++}`, name: '', sequence: '', ...values };
    this.rows(direction).push(row); return row;
  }
  removePrimer(direction, id) {
    const rows = this.rows(direction), index = rows.findIndex(row => row.id === id);
    if (index < 0) return;
    rows.splice(index, 1);
    for (const [key, cell] of this.cells) if (cell.forwardId === id || cell.reverseId === id) this.cells.delete(key);
    if (!rows.length) this.addPrimer(direction);
  }
  active(direction) { return this.rows(direction).filter(row => row.name.trim() || row.sequence.trim()); }
  primerName(direction, row) {
    return row.name || `${direction === 'Forward' ? 'F' : 'R'}${this.rows(direction).findIndex(candidate => candidate.id === row.id) + 1}`;
  }
  sampleName(forward, reverse) { return this.cell(forward.id, reverse.id).name.trim() || (this.emptyNames === 'generate' ? `s_${this.primerName('Forward', forward)}_${this.primerName('Reverse', reverse)}` : ''); }
  cell(forwardId, reverseId) {
    const key = `${forwardId}/${reverseId}`;
    if (!this.cells.has(key)) this.cells.set(key, { forwardId, reverseId, name: '', ...this.defaults, customLength: false });
    return this.cells.get(key);
  }
  setDefaults(min, max, overwrite = false) {
    this.defaults = { min: String(min), max: String(max) };
    for (const cell of this.cells.values()) if (overwrite || !cell.customLength) {
      Object.assign(cell, this.defaults, { customLength: false });
    }
  }
  primers() {
    const names = new Set(), output = [];
    for (const direction of directions) for (const [index, row] of this.rows(direction).entries()) {
      if (!row.name && !row.sequence) continue;
      const name = this.primerName(direction, row), sequence = normalizeSequence(row.sequence);
      validateDefinitionName(name, `${direction} ${index + 1} 行目`);
      if (names.has(name)) throw Error(`配列名が重複しています: ${name}（Forward / Reverse を通して一意にしてください）`);
      if (row.sequence && !isSequenceText(row.sequence)) throw Error(`${name}: 塩基配列には半角アルファベットのみを入力してください。数字、記号、空白は使用できません。`);
      if (sequence.length < 4 || !/^[ACGTBVDHKMRYSWN]+$/.test(sequence)) throw Error(`${name}: 4 塩基以上の DNA 配列を入力してください。IUPAC 縮重塩基も使えます。`);
      names.add(name); output.push({ ...row, name, sequence, direction });
    }
    if (!output.length) throw Error('プライマーの塩基配列を入力してください。配列名は空欄ならF1、R1などを使用します。');
    return output;
  }
  fasta() { return this.primers().map(row => `>${row.name} ${row.direction}\n${row.sequence}\n`).join(''); }
  sampleText() {
    const primers = this.primers(), forward = primers.filter(row => row.direction === 'Forward'), reverse = primers.filter(row => row.direction === 'Reverse');
    if (!forward.length || !reverse.length) throw Error('Forward と Reverse の両方のプライマーを入力してください。');
    const lines = [];
    for (const f of forward) for (const r of reverse) {
      const cell = this.cell(f.id, r.id);
      if (cell.name) validateDefinitionName(cell.name, 'サンプル');
      const name = this.sampleName(f, r); if (!name) continue;
      lines.push([name, f.name, r.name, cell.min.trim() || '0', cell.max.trim() || '0'].join('\t'));
    }
    const text = lines.join('\n') + (lines.length ? '\n' : '');
    if (!lines.length) throw Error('出力するサンプルがありません。交点にサンプル名を入力するか、空欄の自動命名を選んでください。');
    parseSamples(text); return text;
  }
  export() { return { primerText: this.fasta(), sampleText: this.sampleText() }; }
  pastePrimers(direction, rowId, field, text) {
    const rows = this.rows(direction), start = rows.findIndex(row => row.id === rowId), columns = ['name', 'sequence'];
    if (start < 0) throw Error('貼り付け先の行がありません。');
    const { rows: data, column } = parsePrimerClipboard(text, field);
    for (const [offset, values] of data.entries()) {
      const row = rows[start + offset] || this.addPrimer(direction);
      for (const [index, value] of values.entries()) if (columns[column + index]) row[columns[column + index]] = value;
    }
  }
  pasteSamples(forwardId, reverseId, text) {
    const forward = this.active('Forward'), reverse = this.active('Reverse');
    const y = forward.findIndex(row => row.id === forwardId), x = reverse.findIndex(row => row.id === reverseId), data = parseClipboard(text);
    if (y < 0 || x < 0 || y + data.length > forward.length || data.some(row => x + row.length > reverse.length)) throw Error('貼り付け範囲が表を超えています。先に必要なプライマー行を追加してください。');
    for (const [dy, row] of data.entries()) for (const [dx, name] of row.entries()) this.cell(forward[y + dy].id, reverse[x + dx].id).name = name;
  }
  import(primerText, sampleText = '') {
    const samples = sampleText.trim() ? parseSamples(sampleText) : [];
    const roles = new Map();
    for (const sample of samples) for (const [name, direction] of [[sample.forward, 'Forward'], [sample.reverse, 'Reverse']]) {
      if (roles.has(name) && roles.get(name) !== direction) throw Error(`${name}: sample.txt 内で Forward と Reverse の両方に使われています。`);
      roles.set(name, direction);
    }
    const records = [], forwardDefaults = []; let current;
    for (const raw of primerText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith('>')) {
        const [name, ...info] = line.slice(1).trim().split(/\s+/);
        const annotations = info.filter(word => /^(Forward|Reverse)$/i.test(word)).map(word => /^Forward$/i.test(word) ? 'Forward' : 'Reverse');
        if (new Set(annotations).size > 1) throw Error(`${name}: Forward / Reverse 情報が両方あります。`);
        const direction = annotations[0] || roles.get(name) || 'Forward';
        if (!annotations.length && !roles.has(name)) forwardDefaults.push(name);
        if (roles.has(name) && roles.get(name) !== direction) throw Error(`${name}: FASTA の方向情報と sample.txt が一致しません。`);
        current = { name, sequence: '', direction }; records.push(current);
      } else {
        if (!current) throw Error('FASTA の先頭には >配列名 が必要です。');
        current.sequence += line;
      }
    }
    const next = new DefinitionModel(); next.forward = []; next.reverse = [];
    const byName = new Map();
    for (const { direction, ...record } of records) byName.set(record.name, next.addPrimer(direction, record));
    next.primers();
    for (const sample of samples) {
      const f = byName.get(sample.forward), r = byName.get(sample.reverse);
      if (!f || !r) throw Error(`サンプル ${sample.name}: primer FASTA に参照名 ${!f ? sample.forward : sample.reverse} がありません。`);
      Object.assign(next.cell(f.id, r.id), { name: sample.name, min: sample.min ? String(sample.min) : '', max: Number.isFinite(sample.max) ? String(sample.max) : '', customLength: true });
    }
    for (const direction of directions) if (!next.rows(direction).length) next.addPrimer(direction);
    this.nextId = next.nextId; this.forward = next.forward; this.reverse = next.reverse; this.cells = next.cells;
    return { forwardDefaults };
  }
}
