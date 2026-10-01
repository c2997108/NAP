// Keep frequency counts, not a second copy of every read. Exact lengths are
// merged across input jobs before computing the median and display bins.
export const QUALITY_METRIC = {
  source: 'original input read FASTQ header quality annotation',
  fields: ['qs:f:', 'qscore=', 'mean_qscore=', 'mean_qscore_template=', 'qs='],
  missing: 'excluded; no fallback to FASTQ base quality characters',
  duplicates: 'last quality annotation wins',
  binWidth: 1,
};
const increment = (map, key, count = 1) => map.set(key, (map.get(key) || 0) + count);

export function headerQuality(header) {
  // Only inspect annotations after the read ID. Unrelated metadata numbers
  // (read, channel, duration, etc.) must never become quality scores.
  const separator = header.search(/\s/);
  if (separator < 0) return null;
  let quality = null;
  for (const match of header.slice(separator).matchAll(/(?:^|\s)(?:qs:f:|(?:qscore|mean_qscore|mean_qscore_template|qs)=)(\S*)/gi)) {
    const value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(match[1]) ? Number(match[1]) : NaN;
    // The upstream script can append a new qs:f: after an existing one.
    quality = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return quality;
}

export function createReadDistribution() {
  return { lengths: new Map(), qualities: new Map() };
}

export function addReadDistribution(distribution, length, header) {
  increment(distribution.lengths, length);
  const quality = headerQuality(header);
  if (quality !== null) increment(distribution.qualities, Math.floor(quality));
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
  if (!row.segments) return { ...row, meanLength: null, medianLength: null, lengthHistogram: [], qualityHistogram: [], qualityReads: 0, qualityMissing: 0 };
  const ranks = [Math.floor((row.segments - 1) / 2), Math.floor(row.segments / 2)];
  let cumulative = 0, rankIndex = 0, middleSum = 0;
  for (const [length, count] of lengths) {
    cumulative += count;
    while (rankIndex < 2 && ranks[rankIndex] < cumulative) { middleSum += length; rankIndex++; }
    if (rankIndex === 2) break;
  }
  const width = niceStep((row.maxLength - row.minLength + 1) / 32);
  const start = Math.floor(row.minLength / width) * width;
  const bins = Array.from({ length: Math.floor((row.maxLength - start) / width) + 1 }, (_, index) => ({ lower: start + index * width, upper: start + (index + 1) * width - 1, count: 0, bases: 0 }));
  for (const [length, count] of lengths) {
    const bin = bins[Math.floor((length - start) / width)];
    bin.count += count;
    bin.bases += length * count;
  }
  const qualities = [...distribution.qualities].sort((a, b) => a[0] - b[0]);
  const qualityReads = qualities.reduce((sum, [, count]) => sum + count, 0);
  return { ...row, meanLength: row.bases / row.segments, medianLength: middleSum / 2,
    lengthHistogram: bins,
    qualityHistogram: qualities.map(([lower, count]) => ({ lower, upper: lower + 1, count })),
    qualityReads, qualityMissing: row.segments - qualityReads,
  };
}
