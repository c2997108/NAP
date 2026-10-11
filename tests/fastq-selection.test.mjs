import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFastqFiles } from '../public/shared/fastq-selection.mjs';

const files = [
  { name: 'output/sample10.fq', sample: 'sample10', reads: 20, meanLength: 400.004, size: 300 },
  { name: 'output/sample2.fq', sample: 'sample2', reads: 10, meanLength: 400, size: 100 },
  { name: 'output/sample1.fq', sample: 'sample1', reads: 10, meanLength: 600, size: 200 },
  { name: 'output/empty.fq', sample: 'empty', reads: 0, meanLength: null, size: 0 },
];
const samples = options => selectFastqFiles(files, options).map(file => file.sample);

test('FASTQ selection combines name, minimum reads and inclusive length boundaries without rounding', () => {
  assert.deepEqual(samples({ sample: ' SAMPLE ', minReads: 10, minMeanLength: 400, maxMeanLength: 400.004 }), ['sample2', 'sample10']);
  assert.deepEqual(samples({ minReads: 20 }), ['sample10']);
  assert.deepEqual(samples({ minReads: 21 }), []);
  assert.deepEqual(samples({ minMeanLength: 400.001, maxMeanLength: 400.004 }), ['sample10']);
  assert.deepEqual(samples({ maxMeanLength: 400 }), ['sample2']);
  assert.deepEqual(samples({ minMeanLength: 600, maxMeanLength: 600 }), ['sample1']);
});

test('empty FASTQs have no mean and remain selectable only without length filters', () => {
  assert.deepEqual(samples({ sample: 'empty' }), ['empty']);
  assert.deepEqual(samples({ sample: 'empty', minMeanLength: 0 }), []);
  assert.deepEqual(samples({ sample: 'empty', maxMeanLength: 1000 }), []);
});

test('FASTQ sorting is numeric, breaks ties by natural sample name and keeps unknown means last', () => {
  assert.deepEqual(samples({ sort: 'sample-asc' }), ['empty', 'sample1', 'sample2', 'sample10']);
  assert.deepEqual(samples({ sort: 'sample-desc' }), ['sample10', 'sample2', 'sample1', 'empty']);
  assert.deepEqual(samples({ sort: 'reads-desc' }), ['sample10', 'sample1', 'sample2', 'empty']);
  assert.deepEqual(samples({ sort: 'reads-asc' }), ['empty', 'sample1', 'sample2', 'sample10']);
  assert.deepEqual(samples({ sort: 'meanLength-desc' }), ['sample1', 'sample10', 'sample2', 'empty']);
  assert.deepEqual(samples({ sort: 'meanLength-asc' }), ['sample2', 'sample10', 'sample1', 'empty']);
  assert.deepEqual(samples({ sort: 'size-desc' }), ['sample10', 'sample1', 'sample2', 'empty']);
  assert.deepEqual(samples({ sort: 'size-asc' }), ['empty', 'sample2', 'sample1', 'sample10']);
  assert.deepEqual(files.map(file => file.sample), ['sample10', 'sample2', 'sample1', 'empty'], 'Input result order is unchanged');
});

test('FASTQ filters reject negative, fractional read counts, nonfinite values and reversed ranges', () => {
  for (const minReads of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => samples({ minReads }), /最低リード数/);
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => samples({ minMeanLength: value }), /平均リード長/);
    assert.throws(() => samples({ maxMeanLength: value }), /平均リード長/);
  }
  assert.throws(() => samples({ minMeanLength: 500, maxMeanLength: 400 }), /上限は下限以上/);
});
