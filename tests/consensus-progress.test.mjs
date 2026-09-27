import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsensusProgress } from '../public/get-consensus/app/progress.mjs';
import { alignMafft } from '../public/get-consensus/mafft.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const jobs = [{ name: 'A', file: { name: 'A.fq', size: 100 } }, { name: 'B', file: { name: 'B.fq', size: 300 } }];

test('consensus progress weights completed work in each sample and waits for global analysis and BLAST', () => {
  const progress = new ConsensusProgress(jobs);
  progress.update('A', 'reading', 0); progress.update('B', 'reading', 0);
  assert.equal(progress.snapshot().fraction, 0, 'Starting files does not count as completed work');
  progress.update('A', 'reading', 1); progress.update('A', 'clustering', 1);
  progress.update('A', 'aligning', .5);
  let snapshot = progress.snapshot();
  close(snapshot.fraction, .8 * .5 / 4);
  assert.equal(snapshot.files[1].fraction, 0);
  progress.update('A', 'aligning', .1);
  assert.equal(progress.snapshot().fraction, snapshot.fraction, 'Callbacks cannot move a bar backwards');
  for (const job of jobs) progress.update(job.name, 'analysed', 1);
  close(progress.snapshot().fraction, .8);
  assert.ok(progress.snapshot().files.every(file => file.fraction < 1));
  progress.setGlobal('代表配列のアラインメント', .5); close(progress.snapshot().fraction, .85);
  progress.setGlobal('BLAST集計', 1); close(progress.snapshot().fraction, .9);
  progress.update('A', 'blast', 2 / 6, '2/6 reads 処理済み', { processedReads: 2 });
  snapshot = progress.snapshot(); close(snapshot.fraction, .9 + .09 / 12);
  assert.equal(snapshot.files[0].processedReads, 2);
  assert.equal(snapshot.files[0].state, 'running');
  for (const job of jobs) progress.update(job.name, 'blast', 1);
  snapshot = progress.snapshot(); close(snapshot.fraction, .99);
  assert.deepEqual(snapshot.files.map(file => file.fraction), [1, 1]);
  assert.deepEqual(snapshot.files.map(file => file.state), ['complete', 'complete']);
});

const input = '>A\nACGT\n>B\nACGA\n';
function runner(failAt, completed) {
  return async (tool, args, { files }) => {
    const command = tool.replace('mafft-', '');
    if (command === failAt) return { exitCode: 1, stderr: 'test failure', files };
    completed.push(command);
    return { exitCode: 0, stderr: '', stdout: command === 'countlen' ? '2 x 4 - 4\n' : input, files: { ...files, pre: new TextEncoder().encode(input) } };
  };
}

test('MAFFT fractions advance after completed native stages, including automatic strategy and strand adjustment', async () => {
  const completed = [], history = [];
  const result = await alignMafft(input, ['--auto', '--adjustdirection'], runner(null, completed), (command, progress) => {
    history.push({ ...progress, successfulCalls: completed.length });
    assert.equal(progress.completedSteps, completed.length, `${command} must not count before completion`);
  });
  assert.equal(result.stdout, input);
  assert.deepEqual(completed, ['countlen', 'makedirectionlist', 'setdirection', 'tbfast', 'dvtditr', 'f2cl']);
  assert.ok(history.some(step => step.totalSteps === 6 && step.fraction > 0 && step.fraction < 1));
  assert.ok(history.every((step, index) => !index || step.fraction >= history[index - 1].fraction));
  assert.equal(history.at(-1).fraction, 1);
});

test('failed MAFFT stages do not receive completion credit', async () => {
  const completed = [], history = [];
  await assert.rejects(alignMafft(input, ['--auto'], runner('tbfast', completed), (command, progress) => history.push(progress)), /MAFFT tbfast exited 1/);
  assert.deepEqual(completed, ['countlen']);
  assert.equal(history.at(-1).command, 'tbfast');
  assert.equal(history.at(-1).completedSteps, 1);
  assert.equal(history.at(-1).fraction, 1 / 4);
});
