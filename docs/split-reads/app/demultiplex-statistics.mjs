// Keep frequency counts, not a second copy of every read. Exact lengths are
// merged across input jobs before computing the median and display bins.
export const QUALITY_METRIC = {
  source: 'trimmed FASTQ quality (Phred+33)',
  formula: '-10 * log10(mean(10 ** (-Q / 10)))',
  binWidth: 1,
};
const errorProbabilities = Float64Array.from({ length: 94 }, (_, q) => 10 ** (-q / 10));
const increment = (map, key, count = 1) => map.set(key, (map.get(key) || 0) + count);

export function createReadDistribution() {
  return { lengths: new Map(), qualities: new Map() };
}

export function addReadDistribution(distribution, length, quality) {
  increment(distribution.lengths, length);
  let errorSum = 0;
  for (let index = 0; index < quality.length; index++) errorSum += errorProbabilities[quality.charCodeAt(index) - 33];
  const meanQuality = -10 * Math.log10(errorSum / quality.length);
  // Roundoff must not put an all-Q40 read in the Q39 bin.
  increment(distribution.qualities, Math.min(93, Math.max(0, Math.floor(meanQuality + 1e-9))));
}

export function serializeReadDistribution(sample, distribution) {
  return { sample, lengths: [...distribution.lengths], qualities: [...distribution.qualities] };
}

export function mergeReadDistribution(distribution, serialized) {
  for (const [length, count] of serialized.lengths) increment(distribution.lengths, length, count);
  for (const [quality, count] of serialized.qualities) increment(distribution.qualities, quality, count);
}

export function niceStep(value) {
  if (value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value)), fraction = value / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

export function sampleStatistics(row, distribution) {
  const lengths = [...distribution.lengths].sort((a, b) => a[0] - b[0]);
  if (!row.segments) return { ...row, meanLength: null, medianLength: null, lengthHistogram: [], qualityHistogram: [] };
  const ranks = [Math.floor((row.segments - 1) / 2), Math.floor(row.segments / 2)];
  let cumulative = 0, rankIndex = 0, middleSum = 0;
  for (const [length, count] of lengths) {
    cumulative += count;
    while (rankIndex < 2 && ranks[rankIndex] < cumulative) { middleSum += length; rankIndex++; }
    if (rankIndex === 2) break;
  }
  const width = niceStep((row.maxLength - row.minLength + 1) / 32);
  const start = Math.floor(row.minLength / width) * width;
  const bins = Array.from({ length: Math.floor((row.maxLength - start) / width) + 1 }, (_, index) => ({ lower: start + index * width, upper: start + (index + 1) * width - 1, count: 0 }));
  for (const [length, count] of lengths) bins[Math.floor((length - start) / width)].count += count;
  const qualities = [...distribution.qualities].sort((a, b) => a[0] - b[0]);
  return { ...row, meanLength: row.bases / row.segments, medianLength: middleSum / 2,
    lengthHistogram: bins,
    qualityHistogram: qualities.map(([lower, count]) => ({ lower, upper: lower + 1, count })),
  };
}
