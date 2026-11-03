import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['server', 'public', 'scripts', 'test']) {
  for (const name of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (r.status) process.exit(r.status);
  }
}
console.log('JavaScript syntax OK');
