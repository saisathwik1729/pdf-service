// Runs API + worker together for local development: `npm run dev`.
import { spawn } from 'node:child_process';

const specs = [
  ['api', ['src/api/server.js']],
  ['worker', ['src/queue/worker.js']],
];
const procs = [];
for (const [name, args] of specs) procs.push(start(name, args));

function start(name, args) {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (line) => `${name === 'api' ? '\x1b[36m' : '\x1b[35m'}[${name}]\x1b[0m ${line}`;
  for (const s of [p.stdout, p.stderr]) {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) console.log(tag(l));
    });
  }
  p.on('exit', (code) => {
    console.log(tag(`exited with ${code}`));
    // Stop the sibling too; on Windows child processes are not killed with
    // their parent, so a failed start would otherwise leave an orphan running.
    for (const other of procs) if (other !== p && other.exitCode === null) other.kill();
    setTimeout(() => process.exit(code ?? 1), 300);
  });
  return p;
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
