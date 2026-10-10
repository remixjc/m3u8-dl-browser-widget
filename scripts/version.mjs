import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, validateVersion } from './package.mjs';

try {
  if (process.argv.length !== 3) throw new Error('用法：pnpm version:set 1.0.1');
  const version = validateVersion(process.argv[2]);
  const updates = ['package.json', 'manifest.json'].map(file => {
    const target = path.join(PROJECT_ROOT, file);
    const data = JSON.parse(readFileSync(target, 'utf8'));
    data.version = version;
    return [target, `${JSON.stringify(data, null, 2)}\n`];
  });
  const readmePath = path.join(PROJECT_ROOT, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const current = readme.match(/^版本：(\d+\.\d+\.\d+)。/m);
  if (!current) throw new Error('README 缺少可更新的版本行。');
  updates.push([readmePath, readme
    .replace(/^版本：\d+\.\d+\.\d+。/m, `版本：${version}。`)
    .replaceAll(`m3u8-download-helper-v${current[1]}.zip`, `m3u8-download-helper-v${version}.zip`)]);
  for (const [target, content] of updates) writeFileSync(target, content);
  console.log(`版本已同步为 ${version}。请添加 docs/releases/v${version}.md，再提交并推送对应标签。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
