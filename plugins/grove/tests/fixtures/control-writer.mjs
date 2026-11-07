import { Board } from '../../extensions/grove/lib/process/board.mjs';
import { ProcessEngine } from '../../extensions/grove/lib/process/engine.mjs';

const [root, mode] = process.argv.slice(2);
const board = await Board.open(root);
const engine = new ProcessEngine({ board, selfId: 'old-engineer' });
await engine.load();
const task = structuredClone(engine.task('T1'));
process.send({ ready: true });
process.once('message', async () => {
  try {
    if (mode === 'lock-crash') {
      await board.taskLock('T1', async () => process.exit(0));
    } else if (mode === 'log-crash') {
      await board.appendDecision('T1', { action: 'cancel', note: 'cancel during crash' });
    } else if (mode === 'note') {
      await board.decide('T1', {}, (current, items) => {
        const item = { seq: (items.at(-1)?.seq ?? 0) + 1, action: 'note', note: `child ${process.pid}`, at: Date.now() };
        return { item, task: engine.projectDecisions(current, [...items, item]) };
      });
    } else {
      const revision = task.revision ?? 0;
      if (mode === 'claim') task.owner = 'replacement';
      task.revision = revision + 1;
      task.stage = 'routing';
      if (mode === 'queued') {
        const first = board.saveTask(task, 'old-engineer', revision);
        task.revision += 1;
        const second = board.saveTask(task, 'old-engineer', revision + 1);
        process.send({ errors: (await Promise.allSettled([first, second])).map((r) => r.reason?.code) });
        return;
      } else {
        await board.saveTask(task, 'old-engineer', revision);
      }
    }
    process.send({ ok: true });
  } catch (err) {
    process.send({ error: err.code, message: err.message });
  } finally {
    process.disconnect();
  }
});
