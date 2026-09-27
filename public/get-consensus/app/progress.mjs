const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const stages = { reading: [0, .1], clustering: [.1, .3], aligning: [.3, .7], merging: [.7, .8], mapping: [.8, 1], analysed: [1, 1] };
const labels = { reading: 'FASTQ読み込み', clustering: '初回クラスタリング', aligning: 'クラスターのアラインメント', merging: 'クラスター統合', mapping: 'マッピング・ハプロタイプ', analysed: 'BLAST待ち', blast: 'BLAST集計', complete: '完了' };

// Completed work within stages, not elapsed time or the number of started jobs.
// Weights describe work allocation; percentages are not a remaining-time estimate.
export class ConsensusProgress {
  constructor(jobs) {
    this.files = jobs.map(({ file, name }) => ({ name, filename: file.name, weight: Math.max(1, file.size), analysis: 0, blast: 0, phase: '待機中', detail: '', state: 'waiting' }));
    this.global = 0; this.phase = 'サンプル解析'; this.fraction = 0;
  }
  update(name, stage, fraction, detail = '', extra = {}) {
    const file = this.files.find(file => file.name === name);
    if (!file) throw Error(`Unknown sample: ${name}`);
    if (stage === 'blast') {
      this.phase = 'BLAST集計'; file.blast = Math.max(file.blast, clamp(fraction));
      file.state = file.blast === 1 ? 'complete' : 'running';
    } else {
      const [start, end] = stages[stage];
      file.analysis = Math.max(file.analysis, start + (end - start) * clamp(fraction));
      file.state = stage === 'analysed' ? 'waiting' : 'running';
    }
    file.phase = labels[file.state === 'complete' ? 'complete' : stage]; file.detail = detail; Object.assign(file, extra);
  }
  setGlobal(phase, fraction) { this.phase = phase; this.global = Math.max(this.global, clamp(fraction)); }
  snapshot() {
    const weight = this.files.reduce((sum, file) => sum + file.weight, 0);
    const analysis = this.files.reduce((sum, file) => sum + file.weight * file.analysis, 0) / weight;
    const blast = this.files.reduce((sum, file) => sum + file.weight * file.blast, 0) / weight;
    this.fraction = Math.max(this.fraction, Math.min(.99, .8 * analysis + .1 * this.global + .09 * blast));
    return { fraction: this.fraction, phase: this.phase, files: this.files.map(({ weight, analysis, blast, ...file }) => ({ ...file, analysisFraction: analysis, blastFraction: blast, fraction: .85 * analysis + .15 * blast })) };
  }
}
