import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadDistribution, addReadDistribution, serializeReadDistribution, sampleStatistics } from '../public/split-reads/app/demultiplex-statistics.mjs';
import { mergeFileResults } from '../public/split-reads/app/demultiplex-results.mjs';
import { renderFastq } from '../public/split-reads/app/demultiplex-core.mjs';

function fileResult(lengths, q = 40) {
  const distribution = createReadDistribution(), sample = 'sample';
  for (const length of lengths) addReadDistribution(distribution, length, String.fromCharCode(33 + q).repeat(length));
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
  const counts = await merged.files.find(file => file.name === 'sample-counts.tsv').blob.text();
  assert.equal(counts, 'sample\tsegments\tbases\tmin_length\tmax_length\tmean_length\tmedian_length\nsample\t7\t220\t10\t100\t31.43\t20\n');
  const qualities = await merged.files.find(file => file.name === 'quality-histogram.tsv').blob.text();
  assert.match(qualities, /sample\t10\t11\t5\n/); assert.match(qualities, /sample\t40\t41\t2\n/);
  const manifest = JSON.parse(await merged.files.find(file => file.name === 'run.json').blob.text());
  assert.equal(manifest.summary.samples[0].medianLength, 20);
  assert.match(manifest.qualityMetric.source, /trimmed FASTQ/);
  const reversed = mergeFileResults([...results].reverse(), prepared, payload, { concurrency: 2 }, 5);
  assert.deepEqual(reversed.summary.samples, merged.summary.samples);
});

test('quality bins use the trimmed FASTQ error-probability mean and are unchanged by strand reversal', () => {
  const record = { id: 'read', header: 'read qs:f:1', sequence: 'AAAACCCCTTTT', quality: '!!!!I5I5!!!!' };
  const assignment = { number: 1, leftPrimer: 'F', rightPrimer: 'R', start: 5, end: 8, strand: 1 };
  const forward = renderFastq(record, assignment), reverse = renderFastq(record, { ...assignment, strand: -1 });
  assert.equal(forward.quality, 'I5I5'); assert.equal(reverse.quality, '5I5I');
  assert.match(forward.text, /qs:f:1\nCCCC\n\+\nI5I5\n$/);
  const distributions = [forward, reverse].map(output => {
    const distribution = createReadDistribution(); addReadDistribution(distribution, output.length, output.quality);
    return serializeReadDistribution('sample', distribution);
  });
  // Q40/Q20 yields -10*log10((0.0001+0.01)/2) = 22.97,
  // rather than the arithmetic Q mean of 30 or the untrimmed read's Q.
  assert.deepEqual(distributions[0].qualities, [[22, 1]]);
  assert.deepEqual(distributions[1], distributions[0]);
});

test('quality rounding places constant Phred values at the correct 1-Q boundary', () => {
  const distribution = createReadDistribution();
  for (const q of [0, 1, 10, 20, 40, 93]) addReadDistribution(distribution, 400, String.fromCharCode(33 + q).repeat(400));
  assert.deepEqual([...distribution.qualities], [0, 1, 10, 20, 40, 93].map(q => [q, 1]));
});

test('wide length ranges keep all reads in compact bins while the median stays exact', () => {
  const row = fileResult([1, 99, 100, 400, 100000]).summary.samples[0];
  assert.equal(row.medianLength, 100);
  assert.ok(row.lengthHistogram.length <= 33);
  assert.equal(row.lengthHistogram.reduce((sum, bin) => sum + bin.count, 0), 5);
  assert.ok(row.lengthHistogram.some(bin => bin.count === 0), 'Gaps remain visible');
});
