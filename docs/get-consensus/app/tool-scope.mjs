import { fasta } from './sequence.mjs';

export function toolScope(tools, { label = '', signal, options, onProgress = () => {}, onCommand = () => {} }) {
  const files = new Map(), logs = [], warnings = [];
  const save = (name, data) => files.set(name, new Blob([data]));
  const emit = message => { signal?.throwIfAborted(); onProgress({ message: label ? `[${label}] ${message}` : message }); };
  const warn = message => { warnings.push(message); emit(message); };
  const run = async (tool, args, settings = {}) => {
    signal?.throwIfAborted(); onCommand(); emit(`${tool}: ${args.slice(0, 5).join(' ')}`);
    const result = await tools.run(tool, args, { ...settings, signal });
    logs.push(`${label ? `[${label}] ` : ''}$ ${tool} ${args.join(' ')}\n${result.stderr}\n`);
    if (result.exitCode) throw new Error(`${label ? `${label}: ` : ''}${tool} が終了コード ${result.exitCode} で失敗しました。\n${result.stderr.slice(-4000)}`);
    return result;
  };
  const align = async (records, onProgress = () => {}) => {
    signal?.throwIfAborted(); onCommand(); emit(`MAFFT: ${records.length} 配列をアラインメント`);
    const result = await tools.align(fasta(records), { args: [...(options.adjustDirection ? ['--adjustdirection'] : []), '--auto'], signal, onProgress: step => {
      if (typeof step.fraction === 'number') { onProgress(step); emit(`MAFFT ${step.command}: ${step.completedSteps} / ${step.totalSteps ?? '?'} 段階完了`); }
    } });
    logs.push(`${label ? `[${label}] ` : ''}$ mafft --auto (${records.length} sequences)\n${result.stderr}\n`);
    if (result.exitCode) throw new Error(`${label ? `${label}: ` : ''}MAFFT に失敗しました。`);
    return result.stdout;
  };
  return { files, logs, warnings, save, emit, warn, run, align };
}
