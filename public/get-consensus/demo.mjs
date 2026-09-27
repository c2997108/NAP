import { ConsensusTools } from './tool-client.mjs';
window.consensusTools = new ConsensusTools();
const $ = id => document.getElementById(id);
let controller;
$('tool').onchange = () => { $('direction').disabled = $('tool').value === 'cd-hit'; };
$('cancel').onclick = () => controller?.abort();
$('run').onclick = async () => {
  $('run').disabled = true; $('cancel').disabled = false;
  $('status').textContent = '実行中'; $('output').textContent = ''; $('log').textContent = '';
  controller = new AbortController();
  try {
    const tool = $('tool').value, input = $('input').value, direction = $('direction').checked;
    const options = { signal: controller.signal, onProgress: stage => { $('status').textContent = stage.command || stage; } };
    let result;
    if (tool === 'mafft') result = await window.consensusTools.align(input, { ...options, args: ['--auto', ...(direction ? ['--adjustdirection'] : [])] });
    else if (tool === 'vsearch') result = await window.consensusTools.run(tool,
      ['--cluster_fast','input.fa','--id','0.97','--centroids','centroids.fa','--uc','clusters.uc', ...(direction ? ['--strand','both'] : [])],
      { ...options, files: { 'input.fa': input }, outputs: ['centroids.fa','clusters.uc'] });
    else result = await window.consensusTools.run(tool,
      ['-i','input.fa','-o','centroids.fa','-c','1.0','-M','0','-d','0', ...(tool === 'cd-hit-est' ? ['-n','8','-r',direction ? '1' : '0'] : [])],
      { ...options, files: { 'input.fa': input }, outputs: ['centroids.fa','centroids.fa.clstr'] });
    $('output').textContent = Object.entries(result.files).map(([name, bytes]) => `# ${name}\n${new TextDecoder().decode(bytes)}`).join('\n');
    $('log').textContent = result.stderr + result.stdout;
    $('status').textContent = result.exitCode === 0 ? '完了' : `終了コード ${result.exitCode}`;
  } catch (error) {
    $('status').textContent = error.name === 'AbortError' ? '中止しました' : 'エラー';
    $('log').textContent = error.message;
  } finally { $('run').disabled = false; $('cancel').disabled = true; }
};
