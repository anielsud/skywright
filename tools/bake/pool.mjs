// The bake's workers (tools/bake/): jobs dealt round-robin to N workers running `url` (each gets { jobs, ...extra }
// in one message and answers with one list), the answers concatenated. Round-robin keeps the busy (dense) chunks spread.
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';

export const workers = (jobs, per = 4) => Math.max(1, Math.min(Number(process.env.BAKE_WORKERS) || cpus().length - 1, Math.ceil(jobs / per)));
export async function onWorkers(url, jobs, extra = {}, N = workers(jobs.length), transfer = () => []) {
  const parts = Array.from({ length: N }, () => []); jobs.forEach((j, q) => parts[q % N].push(j));
  return (await Promise.all(parts.map((p) => new Promise((res, rej) => { const wk = new Worker(url); wk.once('message', (m) => { res(m); wk.terminate(); }); wk.once('error', rej); wk.postMessage({ jobs: p, ...extra }, p.flatMap(transfer)); })))).flat();
}
