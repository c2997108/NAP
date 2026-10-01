import test from 'node:test';
import assert from 'node:assert/strict';
import { headerQuality, createReadDistribution, addReadDistribution, serializeReadDistribution, sampleStatistics } from '../public/split-reads/app/demultiplex-statistics.mjs';
import { mergeFileResults } from '../public/split-reads/app/demultiplex-results.mjs';
import { renderFastq } from '../public/split-reads/app/demultiplex-core.mjs';

function fileResult(lengths, q = 40) {
  const distribution = createReadDistribution(), sample = 'sample';
  for (const length of lengths) addReadDistribution(distribution, length, q === null ? 'read metadata' : `read qs:f:${q}`);
  const bases = lengths.reduce((sum, length) => sum + length, 0);
  const row = sampleStatistics({ sample, segments: lengths.length, bases, minLength: Math.min(...lengths), maxLength: Math.max(...lengths) }, distribution);
  return { summary: { totalReads: lengths.length, assignedReads: lengths.length, segments: lengths.length, totalBases: bases, batches: 1, samples: [row] },
    distributions: [serializeReadDistribution(sample, distribution)], histogram: [], files: [] };
}

test('length mean and exact median handle odd counts, repeated lengths, and even fractional medians', () => {
  const odd = fileResult([10, 10, 20, 50, 100]).summary.samples[0];
  assert.equal(odd.meanLength, 38); assert.equal(odd.medianLength, 20);
  assert.equal(odd.lengthHistogram.reduce((sum, bin) => sum + bin.count, 0), 5);
  const even = fileResult([1, 2, 7, 12]).summary.samples[0];
  assert.equal(even.meanLength, 5.5); assert.equal(even.medianLength, 4.5);
  const single = fileResult([400]).summary.samples[0];
  assert.equal(single.meanLength, 400); assert.equal(single.medianLength, 400);
  assert.deepEqual(single.lengthHistogram, [{ lower: 400, upper: 400, count: 1 }]);
});

test('parallel files merge length frequencies before computing sample medians and read-weighted means', async () => {
  const results = [fileResult([10, 100], 40), fileResult([20, 20, 20, 20, 30], 10)];
  const prepared = { primers: [], samples: [], normalized: 0, options: {}, cleanFasta: '', tagsFasta: '' };
  const payload = { fastqFiles: [{ name: 'a.fq', size: 1 }, { name: 'b.fq', size: 1 }] };
  const merged = mergeFileResults(results, prepared, payload, { concurrency: 2 }, 5);
  const row = merged.summary.samples[0];
  assert.equal(row.segments, 7); assert.equal(row.bases, 220);
  assert.equal(row.meanLength, 220 / 7); assert.equal(row.medianLength, 20);
  assert.equal(row.minLength, 10); assert.equal(row.maxLength, 100);
  assert.equal(row.lengthHistogram.reduce((sum, bin) => sum + bin.count, 0), 7);
  assert.deepEqual(row.qualityHistogram, [{ lower: 10, upper: 11, count: 5 }, { lower: 40, upper: 41, count: 2 }]);
  assert.equal(row.qualityReads, 7); assert.equal(row.qualityMissing, 0);
  const counts = await merged.files.find(file => file.name === 'sample-counts.tsv').blob.text();
  assert.equal(counts, 'sample\tsegments\tbases\tmin_length\tmax_length\tmean_length\tmedian_length\tquality_reads\tquality_missing\nsample\t7\t220\t10\t100\t31.43\t20\t7\t0\n');
  const qualities = await merged.files.find(file => file.name === 'quality-histogram.tsv').blob.text();
  assert.match(qualities, /sample\t10\t11\t5\n/); assert.match(qualities, /sample\t40\t41\t2\n/);
  const manifest = JSON.parse(await merged.files.find(file => file.name === 'run.json').blob.text());
  assert.equal(manifest.summary.samples[0].medianLength, 20);
  assert.match(manifest.qualityMetric.source, /header quality annotation/);
  const reversed = mergeFileResults([...results].reverse(), prepared, payload, { concurrency: 2 }, 5);
  assert.deepEqual(reversed.summary.samples, merged.summary.samples);
});

test('quality bins use header scores, preserve output base qualities, and are unchanged by trimming or strand reversal', () => {
  const record = { id: 'read', header: 'read qs:f:1', sequence: 'AAAACCCCTTTT', quality: '!!!!I5I5!!!!' };
  const assignment = { number: 1, leftPrimer: 'F', rightPrimer: 'R', start: 5, end: 8, strand: 1 };
  const forward = renderFastq(record, assignment), reverse = renderFastq(record, { ...assignment, strand: -1 });
  assert.equal(forward.text.split('\n')[3], 'I5I5'); assert.equal(reverse.text.split('\n')[3], '5I5I');
  assert.match(forward.text, /qs:f:1\nCCCC\n\+\nI5I5\n$/);
  const distributions = [forward, reverse].map(output => {
    const distribution = createReadDistribution(); addReadDistribution(distribution, output.length, output.text.split('\n')[0]);
    return serializeReadDistribution('sample', distribution);
  });
  assert.deepEqual(distributions[0].qualities, [[1, 1]], 'Use qs:f:1, irrespective of the Q40/Q20 quality characters');
  assert.deepEqual(distributions[1], distributions[0]);
});

test('header quality bins retain zero and decimal values without Phred-character conversion or clipping', () => {
  const distribution = createReadDistribution();
  for (const q of [0, 1, 10, 20, 40, 93, 100.9]) addReadDistribution(distribution, 400, `read qs:f:${q}`);
  assert.deepEqual([...distribution.qualities], [0, 1, 10, 20, 40, 93, 100].map(q => [q, 1]));
  addReadDistribution(distribution, 400, 'read qs:f:20.9999999999');
  assert.equal(distribution.qualities.get(20), 2);
});

test('only explicit quality annotations after the read ID are recognized, including appended overrides', () => {
  for (const field of ['qs:f:', 'qscore=', 'mean_qscore=', 'mean_qscore_template=', 'qs=']) {
    assert.equal(headerQuality(`read runid=123 ${field}17.25 ch=8`), 17.25);
  }
  assert.equal(headerQuality('read\tqs:f:+1.25e1\tch=9'), 12.5);
  assert.equal(headerQuality('read qs:f:.5'), 0.5);
  assert.equal(headerQuality('read qs:f:10 runid=1 qs:f:20'), 20);
  for (const header of ['read', 'qs:f:30 read=1', 'read ch=17 read=30 duration=10', 'read comment=qs:f:30',
    'read qs:f:', 'read qs:f:NaN', 'read qs:f:Infinity', 'read qs:f:-1', 'read qs:f:20suffix', 'read qs:f:1e999',
    'read qs:f:10 qs:f:']) assert.equal(headerQuality(header), null, header);
});

test('missing header quality is excluded while length statistics and cross-file coverage remain correct', () => {
  const results = [fileResult([350, 360], 30.2), fileResult([390, 400, 400], null)];
  const prepared = { primers: [], samples: [], normalized: 0, options: {}, cleanFasta: '', tagsFasta: '' };
  const merged = mergeFileResults(results, prepared, { fastqFiles: [] }, { concurrency: 2 }, 5);
  const row = merged.summary.samples[0];
  assert.equal(row.meanLength, 380); assert.equal(row.medianLength, 390);
  assert.equal(row.qualityReads, 2); assert.equal(row.qualityMissing, 3);
  assert.deepEqual(row.qualityHistogram, [{ lower: 30, upper: 31, count: 2 }]);
  const missing = fileResult([100, 200], null).summary.samples[0];
  assert.deepEqual(missing.qualityHistogram, []);
  assert.equal(missing.qualityReads, 0); assert.equal(missing.qualityMissing, 2);
  assert.equal(missing.meanLength, 150); assert.equal(missing.medianLength, 150);
});

test('wide length ranges keep all reads in compact bins while the median stays exact', () => {
  const row = fileResult([1, 99, 100, 400, 100000]).summary.samples[0];
  assert.equal(row.medianLength, 100);
  assert.ok(row.lengthHistogram.length <= 33);
  assert.equal(row.lengthHistogram.reduce((sum, bin) => sum + bin.count, 0), 5);
  assert.ok(row.lengthHistogram.some(bin => bin.count === 0), 'Gaps remain visible');
});
