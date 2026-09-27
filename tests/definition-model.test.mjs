import test from 'node:test';
import assert from 'node:assert/strict';
import { DefinitionModel } from '../public/split-reads/app/definition-model.mjs';
import { prepareInputs, parseSamples, assignHits, DEFAULT_OPTIONS } from '../public/split-reads/app/demultiplex-core.mjs';

function fixture() {
  const model = new DefinitionModel(), f = model.forward[0], r = model.reverse[0];
  model.emptyNames = 'omit';
  Object.assign(f, { name: 'F1', sequence: 'acgtacga' }); Object.assign(r, { name: 'R1', sequence: 'TTGCTAAC' });
  model.cell(f.id, r.id).name = 'sample_A';
  return { model, f, r };
}
test('FASTA combines Forward and Reverse records with annotation, preserving the entered strand', () => {
  const { model } = fixture();
  assert.equal(model.fasta(), '>F1 Forward\nACGTACGA\n>R1 Reverse\nTTGCTAAC\n');
  const definitions = model.export(), prepared = prepareInputs(definitions.primerText, definitions.sampleText);
  assert.equal(prepared.primers.length, 2); assert.equal(prepared.samples.length, 1);
  assert.equal(prepared.samples[0].reverse, 'R1');
});
test('unnamed sequence-only primers use row defaults consistently in FASTA, sample references and saved-file round trips', () => {
  const model = new DefinitionModel();
  model.pastePrimers('Forward', model.forward[0].id, 'sequence', 'acgtacga\nGCTAGCTT');
  model.pastePrimers('Reverse', model.reverse[0].id, 'sequence', 'TTGCTAAC\nGATCGATC');
  model.addPrimer('Forward'); model.addPrimer('Reverse');
  const definitions = model.export(), prepared = prepareInputs(definitions.primerText, definitions.sampleText);
  assert.equal(definitions.primerText, '>F1 Forward\nACGTACGA\n>F2 Forward\nGCTAGCTT\n>R1 Reverse\nTTGCTAAC\n>R2 Reverse\nGATCGATC\n');
  assert.deepEqual(prepared.samples.map(sample => [sample.name, sample.forward, sample.reverse]), [
    ['s_F1_R1', 'F1', 'R1'], ['s_F1_R2', 'F1', 'R2'], ['s_F2_R1', 'F2', 'R1'], ['s_F2_R2', 'F2', 'R2']
  ]);
  assert.ok([...model.forward, ...model.reverse].every(row => row.name === ''), 'Defaults do not overwrite the editable draft');
  const next = new DefinitionModel(); next.import(definitions.primerText, definitions.sampleText);
  assert.deepEqual(next.export(), definitions);
});
test('default primer names retain sample assignments when renumbered and still reject duplicates and forbidden characters', () => {
  const model = new DefinitionModel(), f1 = model.forward[0], r = model.reverse[0];
  f1.sequence = 'ACGTACGA'; r.sequence = 'TTGCTAAC';
  const f2 = model.addPrimer('Forward', { sequence: 'GCTAGCTT' }), cell = model.cell(f2.id, r.id);
  Object.assign(cell, { name: 'saved_sample', min: '28', max: '200', customLength: true });
  assert.match(model.sampleText(), /saved_sample\tF2\tR1\t28\t200/);
  f2.name = 'F1'; assert.throws(() => model.export(), /重複/);
  f2.name = ''; r.name = 'F1'; assert.throws(() => model.export(), /重複/);
  r.name = '';
  for (const invalid of [' ', '*', '日本語']) {
    f2.name = invalid; assert.throws(() => model.export(), /半角英数字/);
  }
  f2.name = ''; model.removePrimer('Forward', f1.id);
  assert.equal(model.sampleText(), 'saved_sample\tF1\tR1\t28\t200\n');
  assert.equal(model.cell(f2.id, r.id), cell);
  f2.name = 'custom_F'; assert.match(model.sampleText(), /saved_sample\tcustom_F\tR1/);
  f2.name = ''; assert.match(model.sampleText(), /saved_sample\tF1\tR1/);
});
test('renaming axes preserves sample cells and per-pair lengths and updates sample.txt references', () => {
  const { model, f, r } = fixture(), cell = model.cell(f.id, r.id);
  cell.min = '28'; cell.max = '0'; cell.customLength = true;
  f.name = 'F_renamed'; r.name = 'R_renamed';
  assert.equal(model.sampleText(), 'sample_A\tF_renamed\tR_renamed\t28\t0\n');
  assert.equal(model.cell(f.id, r.id).name, 'sample_A');
  model.setDefaults('10', '100'); assert.equal(cell.max, '0');
  model.setDefaults('20', '200', true); assert.equal(cell.max, '200');
  assert.equal(model.sampleText(), 'sample_A\tF_renamed\tR_renamed\t20\t200\n');
});
test('Excel paste fills primer rows and a Forward-by-Reverse sample rectangle; blank pairs are excluded', () => {
  const model = new DefinitionModel(); model.emptyNames = 'omit';
  model.pastePrimers('Forward', model.forward[0].id, 'name', 'F1\tACGTACGA\r\nF2\tGCTAGCTT\r\n');
  model.pastePrimers('Reverse', model.reverse[0].id, 'name', 'R1\tTTGCTAAC\nR2\tGATCGATC');
  model.pasteSamples(model.forward[0].id, model.reverse[0].id, 'A\t\n\tB');
  assert.equal(model.sampleText(), 'A\tF1\tR1\t0\t0\nB\tF2\tR2\t0\t0\n');
  assert.throws(() => model.pasteSamples(model.forward[1].id, model.reverse[1].id, 'C\tD'), /範囲/);
  assert.equal(model.cell(model.forward[1].id, model.reverse[1].id).name, 'B');
  model.removePrimer('Forward', model.forward[0].id);
  assert.equal(model.sampleText(), 'B\tF2\tR2\t0\t0\n');
});
test('primer paste accepts spaces, repeated and mixed delimiters, CRLF and blank lines and preserves sample links', () => {
  const { model, f } = fixture();
  model.pastePrimers('Forward', f.id, 'name', '\uFEFF  F_A   acgtacga  \r\n\r\nF_B\t\tGCTAGCTT\r\n F_C \t  ACGTRYSW \r\n   \r\n');
  assert.deepEqual(model.primers().filter(row => row.direction === 'Forward').map(({ name, sequence }) => ({ name, sequence })), [
    { name: 'F_A', sequence: 'ACGTACGA' }, { name: 'F_B', sequence: 'GCTAGCTT' }, { name: 'F_C', sequence: 'ACGTRYSW' },
  ]);
  assert.equal(model.forward.length, 3);
  assert.equal(model.sampleText(), 'sample_A\tF_A\tR1\t0\t0\n');
  const prepared = prepareInputs(model.fasta(), model.sampleText());
  assert.equal(prepared.primers.length, 4); assert.equal(prepared.samples[0].forward, 'F_A');
});
test('two-column blocks fill both primer fields when pasted into a sequence cell; a single pair works in the name cell', () => {
  const { model, f, r } = fixture();
  model.pastePrimers('Reverse', r.id, 'sequence', 'R_A  TTGCTAAC\nR_B\tGATCGATC\n');
  assert.deepEqual(model.reverse.map(({ name, sequence }) => ({ name, sequence })), [
    { name: 'R_A', sequence: 'TTGCTAAC' }, { name: 'R_B', sequence: 'GATCGATC' },
  ]);
  model.pastePrimers('Forward', f.id, 'name', 'F_single    ACGTRYSM');
  assert.equal(model.sampleText(), 'sample_A\tF_single\tR_A\t0\t0\n');
  assert.match(model.fasta(), />F_single Forward\nACGTRYSM\n/);
});
test('sequence-only paste preserves primer names, rejects nonletters and normalizes lowercase DNA', () => {
  const { model, f } = fixture();
  model.pastePrimers('Forward', f.id, 'sequence', 'acgt acga');
  assert.equal(f.name, 'F1'); assert.equal(model.forward.length, 1);
  assert.throws(() => model.fasta(), /アルファベット/);
  for (const invalid of ['ACGT1', 'ACGT-', 'ACGT*', 'ACGT_', 'ACGT.', 'ACGT日本語', 'ＡＣＧＴ']) {
    f.sequence = invalid; assert.throws(() => model.fasta(), /アルファベット/);
  }
  model.pastePrimers('Forward', f.id, 'sequence', 'acgtacga');
  assert.match(model.fasta(), />F1 Forward\nACGTACGA\n/);
  const second = model.addPrimer('Forward', { name: 'F2' });
  model.pastePrimers('Forward', f.id, 'sequence', 'GCTAGCTT\nACGTRYSW\n');
  assert.equal(f.name, 'F1'); assert.equal(second.name, 'F2');
  assert.equal(f.sequence, 'GCTAGCTT'); assert.equal(second.sequence, 'ACGTRYSW');
});
test('annotated FASTA and sample.txt round trip, including zero maximum and different lengths', () => {
  const { model, f, r } = fixture(); Object.assign(model.cell(f.id, r.id), { min: '28', max: '0' });
  const original = model.export(), next = new DefinitionModel(); next.import(original.primerText, original.sampleText);
  assert.deepEqual(next.export(), original);
  assert.equal(parseSamples(next.sampleText())[0].max, Infinity);
  const fastaOnly = new DefinitionModel(); fastaOnly.import(original.primerText);
  assert.equal(fastaOnly.fasta(), original.primerText);
  assert.equal(fastaOnly.sampleText(), 's_F1_R1\tF1\tR1\t0\t0\n');
  fastaOnly.emptyNames = 'omit'; assert.throws(() => fastaOnly.sampleText(), /出力するサンプル/);
});
test('unannotated FASTA infers direction from sample references; failed import leaves the draft intact', () => {
  const { model } = fixture(), old = model.export();
  model.import('>R\nTTGCTAAC\n>F\nACGTACGA\n', 'new_sample F R 28 28\n');
  assert.equal(model.fasta(), '>F Forward\nACGTACGA\n>R Reverse\nTTGCTAAC\n');
  const current = model.export();
  assert.throws(() => model.import('>unknown\nACG1\n'), /アルファベット/); assert.deepEqual(model.export(), current);
  assert.throws(() => model.import('>F Reverse\nACGTACGA\n>R Reverse\nTTGCTAAC\n', 's F R 28 28'), /一致/);
  assert.deepEqual(model.export(), current);
  assert.notDeepEqual(current, old);
});
test('unannotated unreferenced primers fall back to Forward while annotations and sample roles classify other records', () => {
  const model = new DefinitionModel();
  const report = model.import('>usedR\nTTGCTAAC\n>unknown\nACGTRYSW\n>usedF\nACGTACGA\n>annotated reverse extra description\nGATCGATC\n', 'sample_A\tusedF\tusedR\t28\t200');
  assert.deepEqual(report.forwardDefaults, ['unknown']);
  assert.deepEqual(model.active('Forward').map(row => row.name), ['unknown', 'usedF']);
  assert.deepEqual(model.active('Reverse').map(row => row.name), ['usedR', 'annotated']);
  assert.match(model.fasta(), />unknown Forward\nACGTRYSW/);
  assert.match(model.sampleText(), /sample_A\tusedF\tusedR\t28\t200/);
  const next = new DefinitionModel(), definitions = model.export(); next.import(definitions.primerText, definitions.sampleText);
  assert.deepEqual(next.export(), definitions);
});
test('FASTA without directions or sample references can be imported into Forward for editing', () => {
  const model = new DefinitionModel();
  const report = model.import('>unknown_A\nACGTACGA\n>unknown_B\nTTGCTAAC\n');
  assert.deepEqual(report.forwardDefaults, ['unknown_A', 'unknown_B']);
  assert.equal(model.fasta(), '>unknown_A Forward\nACGTACGA\n>unknown_B Forward\nTTGCTAAC\n');
  assert.equal(model.active('Reverse').length, 0);
});
test('invalid names, DNA, duplicates, sample filenames and lengths are rejected before use or save', () => {
  const { model, f, r } = fixture();
  f.name = 'F with space'; assert.throws(() => model.fasta(), /半角英数字/);
  f.name = 'R1'; assert.throws(() => model.fasta(), /重複/);
  f.name = 'F1'; f.sequence = 'ACGTU'; assert.throws(() => model.fasta(), /DNA/);
  f.sequence = 'ACGTRYSW'; assert.match(model.fasta(), /ACGTRYSW/);
  const cell = model.cell(f.id, r.id); cell.name = '../bad'; assert.throws(() => model.sampleText(), /半角英数字/);
  cell.name = 'good'; cell.min = ''; assert.equal(parseSamples(model.sampleText())[0].min, 0);
  cell.min = '500'; cell.max = '300'; assert.throws(() => model.sampleText(), /5列/);
  cell.max = '0'; assert.match(model.sampleText(), /500\t0/);
});
test('blank length bounds are independent and automatic sample names follow renamed primers', () => {
  const model = new DefinitionModel(), f = model.forward[0], r = model.reverse[0];
  Object.assign(f, { name: 'F-1.', sequence: 'ACGTACGA' }); Object.assign(r, { name: 'R_2', sequence: 'TTGCTAAC' });
  assert.deepEqual(model.defaults, { min: '', max: '' });
  assert.equal(model.sampleText(), 's_F-1._R_2\tF-1.\tR_2\t0\t0\n');
  assert.equal(parseSamples(model.sampleText())[0].max, Infinity);
  const cell = model.cell(f.id, r.id); cell.min = '700';
  assert.equal(parseSamples(model.sampleText())[0].min, 700); assert.equal(parseSamples(model.sampleText())[0].max, Infinity);
  cell.min = ''; cell.max = '200'; assert.equal(parseSamples(model.sampleText())[0].min, 0);
  f.name = 'F_new'; assert.equal(parseSamples(model.sampleText())[0].name, 's_F_new_R_2');
  cell.name = 'manual'; r.name = 'R_new'; assert.equal(parseSamples(model.sampleText())[0].name, 'manual');
  cell.name = ''; model.emptyNames = 'omit'; assert.throws(() => model.sampleText(), /出力するサンプル/);
});
test('file input accepts missing length bounds and enforces the same ASCII name alphabet', () => {
  const sample = parseSamples('\tF-1.\tR_2\t\t\n')[0];
  assert.equal(sample.name, 's_F-1._R_2'); assert.equal(sample.min, 0); assert.equal(sample.max, Infinity);
  assert.equal(parseSamples('A F R')[0].max, Infinity);
  assert.equal(parseSamples('A\tF\tR\t\t100\n')[0].max, 100);
  assert.equal(parseSamples('A\tF\tR\t25\t\n')[0].min, 25);
  for (const invalid of ['日本語', 'A+B', 'a/b', 'a:b', 'a?b', 'a b', 'a#b', 'a*b']) {
    assert.throws(() => parseSamples(`${invalid}\tF\tR\t0\t0`), /半角英数字/);
    if (!invalid.includes(' ')) assert.throws(() => prepareInputs(`>${invalid}\nACGT\n>R\nTGCA\n`, 's F R 0 0'), /半角英数字/);
  }
  assert.deepEqual(prepareInputs('>F Forward optional description\nACGT\n>R Reverse\nTGCA\n', 's F R').primers.map(primer => primer.name), ['F', 'R']);
  assert.deepEqual(parseSamples('\tF\tR\t\t\nA\tF2\tR2\t\t', { emptyNames: 'omit' }).map(row => row.name), ['A']);
});

test('blank bounds accept short and long amplicons and explicit single bounds still filter assignments', () => {
  const f = { name: 'F', family: 'F', sequence: 'ACGTACGA' }, r = { name: 'R', family: 'R', sequence: 'TTGCTAAC' };
  const hits = [50, 10000].flatMap(length => [
    { query: `read${length}`, primer: f, identity: 100, score: 30, qstart: 1, qend: 8, sstart: 1, send: 8 },
    { query: `read${length}`, primer: r, identity: 100, score: 30, qstart: length - 7, qend: length, sstart: 8, send: 1 }
  ]);
  const lengths = text => assignHits(hits, hits, { options: DEFAULT_OPTIONS, samples: parseSamples(text) }).assignments.map(assignment => assignment.ampliconLength);
  assert.deepEqual(lengths('s\tF\tR\t\t'), [50, 10000]);
  assert.deepEqual(lengths('s\tF\tR\t700\t'), [10000]);
  assert.deepEqual(lengths('s\tF\tR\t\t300'), [50]);
});
