import { createReadDistribution, mergeReadDistribution, sampleStatistics, QUALITY_METRIC } from './demultiplex-statistics.mjs';

export const UPSTREAM_COMMIT = '53c159aeedff6038f0fe5ab032bdd4f064067483';
export const ASSIGNMENT_HEADER = 'read_id\tsegment\tsample\tleft_primer\tright_primer\tstart\tend\tstrand\tamplicon_length\ttrimmed_length\n';
const textBlob = chunks => new Blob(chunks, { type: 'text/plain;charset=utf-8' });

export function reportFiles(summary, histogram, { options, diagnostics, fastqFiles, execution }) {
  const rows = summary.samples;
  const reports = {
    'sample-counts.tsv': 'sample\tsegments\tbases\tmin_length\tmax_length\tmean_length\tmedian_length\tquality_reads\tquality_missing\n' + rows.map(row => `${row.sample}\t${row.segments}\t${row.bases}\t${row.minLength}\t${row.maxLength}\t${row.meanLength.toFixed(2)}\t${row.medianLength}\t${row.qualityReads}\t${row.qualityMissing}\n`).join(''),
    'length-histogram.tsv': 'sample\tlower_bp\tupper_bp\tsegments\tbases\n' + [...histogram].sort((a, b) => a.sample.localeCompare(b.sample) || a.bin - b.bin).map(h => [h.sample, h.bin === -1 ? 0 : Math.ceil(100 * 1.1 ** h.bin), h.bin === -1 ? 99 : Math.ceil(100 * 1.1 ** (h.bin + 1)) - 1, h.segments, h.bases].join('\t') + '\n').join(''),
    'length-distribution.tsv': 'sample\tlower_bp\tupper_bp_inclusive\tsegments\n' + rows.flatMap(row => row.lengthHistogram.map(bin => `${row.sample}\t${bin.lower}\t${bin.upper}\t${bin.count}\n`)).join(''),
    'quality-histogram.tsv': 'sample\tlower_header_q\tupper_header_q_exclusive\tsegments\n' + rows.flatMap(row => row.qualityHistogram.map(bin => `${row.sample}\t${bin.lower}\t${bin.upper}\t${bin.count}\n`)).join(''),
    'output.stats': `Total: ${summary.totalReads} reads, Demultiplexed: ${summary.segments} reads\nAssigned input reads: ${summary.assignedReads}\nUnassigned input reads: ${summary.unassignedReads}\n` + rows.map(row => `  ${row.sample}: ${row.segments} reads, ${row.bases} bp\n`).join(''),
    'run.json': JSON.stringify({ tool: 'webBLASTN nanopore split-barcode', blastVersion: '2.16.0', upstreamCommit: UPSTREAM_COMMIT, options, diagnostics, qualityMetric: QUALITY_METRIC, inputs: fastqFiles.map(file => ({ name: file.name, size: file.size })), ...(execution ? { execution } : {}), summary }, null, 2) + '\n'
  };
  return Object.entries(reports).map(([name, text]) => ({ name, blob: textBlob([text]) }));
}

export function mergeFileResults(results, prepared, payload, execution, elapsedMs) {
  const parts = new Map([['assignments.tsv', [ASSIGNMENT_HEADER]]]), counts = new Map(), bins = new Map(), distributions = new Map();
  let totalReads = 0, assignedReads = 0, segments = 0, totalBases = 0, batches = 0, memoryRetries = 0;
  // results are indexed by input position, so output order is independent of
  // scheduling and completion order. Keep large FASTQ data as Blob parts.
  for (const result of results) {
    const summary = result.summary;
    totalReads += summary.totalReads; assignedReads += summary.assignedReads;
    segments += summary.segments; totalBases += summary.totalBases; batches += summary.batches;
    memoryRetries += summary.memoryRetries || 0;
    for (const row of summary.samples) {
      const previous = counts.get(row.sample);
      if (!previous) counts.set(row.sample, { ...row });
      else {
        previous.segments += row.segments; previous.bases += row.bases;
        previous.minLength = Math.min(previous.minLength, row.minLength); previous.maxLength = Math.max(previous.maxLength, row.maxLength);
      }
    }
    for (const row of result.histogram) {
      const key = `${row.sample}\t${row.bin}`, previous = bins.get(key);
      if (!previous) bins.set(key, { ...row });
      else { previous.segments += row.segments; previous.bases += row.bases; }
    }
    for (const distribution of result.distributions) {
      if (!distributions.has(distribution.sample)) distributions.set(distribution.sample, createReadDistribution());
      mergeReadDistribution(distributions.get(distribution.sample), distribution);
    }
    for (const { name, blob } of result.files) {
      if (!parts.has(name)) parts.set(name, []);
      parts.get(name).push(blob);
    }
  }
  if (!totalReads) throw new Error('FASTQ にリードがありません。');
  const samples = [...counts.values()].sort((a, b) => a.sample.localeCompare(b.sample)).map(row => sampleStatistics(row, distributions.get(row.sample)));
  const summary = { totalReads, assignedReads, unassignedReads: totalReads - assignedReads, segments, totalBases, batches, memoryRetries, samples, primerSequences: prepared.primers.length, sampleDefinitions: prepared.samples.length, normalizedPrimerNames: prepared.normalized, concurrency: execution.concurrency, completedFiles: results.length, elapsedMs };
  const files = [...parts].map(([name, chunks]) => ({ name, blob: textBlob(chunks) }));
  files.push({ name: 'primer-clean.fa', blob: textBlob([prepared.cleanFasta]) }, { name: 'primer-tags.fa', blob: textBlob([prepared.tagsFasta]) }, ...reportFiles(summary, [...bins.values()], { ...payload, options: prepared.options, execution }));
  return { summary, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
}
