import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { browserTests, suites } from './test-suites.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [group, ...args] = process.argv.slice(2);

function selectTests() {
  if (group === 'browser') {
    if (!args.length) return Object.values(browserTests);
    const name = args.shift();
    if (Object.hasOwn(browserTests, name)) return [browserTests[name]];
    throw new Error(`未知浏览器测试分组 ${name}，可选分组为 ${Object.keys(browserTests).join('、')}`);
  }
  if (Object.hasOwn(suites, group)) return suites[group];
  throw new Error(`未知测试分组 ${group}`);
}

const tests = selectTests();
for (const [index, test] of tests.entries()) {
  const command = Array.isArray(test) ? [...test] : [test];
  // npm used to append extra arguments to the final command in each && chain.
  if (index === tests.length - 1) command.push(...args);
  console.log(`[${index + 1}/${tests.length}] node ${command.join(' ')}`);
  const result = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) console.error(`${command[0]} 收到信号 ${result.signal}`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
