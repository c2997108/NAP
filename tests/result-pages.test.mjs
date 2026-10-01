import test from 'node:test';
import assert from 'node:assert/strict';
import { resultPage, resultTable, fileHref, scriptJson } from '../public/shared/result-page.mjs';
import { inputDefinitionFiles, splitFastqArchiveFiles, SPLIT_RESULT_PAGE } from '../public/split-reads/app/result-page.mjs';
import { mergeFileResults } from '../public/split-reads/app/demultiplex-results.mjs';
import { createReadDistribution, addReadDistribution, serializeReadDistribution, sampleStatistics } from '../public/split-reads/app/demultiplex-statistics.mjs';
import { consensusResultPage } from '../public/get-consensus/app/result-page.mjs';

test('saved report markup and embedded script data safely preserve filenames, annotations, and closing-script text', () => {
  const dangerous = '</script><img src=x onerror=alert(1)> & "data"';
  const html = resultPage({ title: dangerous, body: resultTable(['name'], [[dangerous]]), script: `const data=${scriptJson({ value: dangerous })};`, savedAt: '2026-10-02T00:00:00Z' });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;/script&gt;'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html));
  assert.equal(fileHref('output/a & b.fq'), './output/a%20%26%20b.fq');
});

test('archived primer.fa and sample.txt preserve the exact submitted texts including annotations and tabs', async () => {
  const input = { primerText: '>F Forward optional info\r\nACGT\r\n>R Reverse\r\nTGCA\r\n', sampleText: 'sample\tF\tR\t0\t0\r\n' };
  const files = inputDefinitionFiles(input);
  assert.deepEqual(files.map(file => file.name), ['primer.fa', 'sample.txt']);
  assert.equal(await files[0].blob.text(), input.primerText);
  assert.equal(await files[1].blob.text(), input.sampleText);
});

test('merged split archives contain submitted definitions and standalone result pages with links for each ZIP layout', async () => {
  const distribution = createReadDistribution(); addReadDistribution(distribution, 400, 'read qs:f:30');
  const sample = sampleStatistics({ sample: 'S', segments: 1, bases: 400, minLength: 400, maxLength: 400 }, distribution);
  const result = { summary: { totalReads: 1, assignedReads: 1, segments: 1, totalBases: 400, batches: 1, samples: [sample] }, histogram: [], distributions: [serializeReadDistribution('S', distribution)], files: [{ name: 'output/S.fq', blob: new Blob(['FASTQ']) }] };
  const prepared = { primers: [], samples: [], normalized: 0, options: { batchSize: 2 }, cleanFasta: '', tagsFasta: '' };
  const inputs = { fastqFiles: [{ name: '<input>.fq', size: 8 }], primerText: '>F Forward\nACGT\n', sampleText: 'S\tF\tR\t0\t0\n' };
  const merged = mergeFileResults([result], prepared, inputs, { concurrency: 1 }, 5);
  assert.equal(await merged.files.find(file => file.name === 'primer.fa').blob.text(), inputs.primerText);
  assert.equal(await merged.files.find(file => file.name === 'sample.txt').blob.text(), inputs.sampleText);
  const fullReport = await merged.files.find(file => file.name === SPLIT_RESULT_PAGE).blob.text();
  assert.ok(fullReport.includes('href="./output/S.fq"'));
  assert.ok(fullReport.includes('data-chart="quality"'));
  assert.ok(fullReport.includes('&lt;input&gt;.fq'));
  assert.ok(fullReport.includes('&gt;F Forward'));
  const fastqReport = await merged.fastqReport.text();
  assert.ok(fastqReport.includes('href="./S.fq"'));
  assert.ok(!fastqReport.includes('href="./output/S.fq"'));
  assert.deepEqual(splitFastqArchiveFiles(merged.files).map(file => file.name).sort(), ['S.fq', 'primer.fa', 'sample.txt']);
});

test('saved consensus result page includes counts, run options, embedded alignments, and safely escaped sample metadata', () => {
  const result = { manifest: { samples: [], warnings: [], options: { minReads: 3 }, consensuses: 1, representatives: 1, started: '', finished: '' }, samples: [], names: ['</script>'], rows: [{ id: 'representative', seq: 'ACGT', counts: [6], total: 6 }], entries: [{ id: 'representative', alignment: '>read </script>\nACGT\n' }], alignment: '>representative\nACGT\n', files: new Map() };
  const html = consensusResultPage(result, '</script><iframe>');
  assert.ok(html.includes('id="counts"'));
  assert.ok(html.includes('クラスターの最小リード数'));
  assert.ok(html.includes('id="alignment"'));
  assert.ok(html.includes('function alignmentViewer'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('&lt;/script&gt;&lt;iframe&gt;'));
});
