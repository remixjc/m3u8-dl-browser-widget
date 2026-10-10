import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  PACKAGE_FOLDER, PROJECT_ROOT, RELEASE_FILES, packageExtension, validateVersion,
} from '../scripts/package.mjs';

const version = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

// 从中央目录独立读取 ZIP，而不是调用打包器的内部 ZIP 实现。
function readArchive(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const result = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const local = archive.readUInt32LE(offset + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const dataOffset = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = inflateRawSync(archive.subarray(dataOffset, dataOffset + compressedSize));
    assert.equal(data.length, size);
    result.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return result;
}

test('发布包可解压，包含所需资源，排除测试、Git 与本机数据', () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'm3u8-package-'));
  const result = packageExtension({ outputDir: output, tag: `v${version}` });
  const archive = readFileSync(result.archivePath);
  const entries = readArchive(archive);
  assert.deepEqual([...entries.keys()], RELEASE_FILES.map(file => `${PACKAGE_FOLDER}/${file}`));
  const manifest = JSON.parse(entries.get(`${PACKAGE_FOLDER}/manifest.json`));
  assert.equal(manifest.version, version);
  assert.ok(entries.has(`${PACKAGE_FOLDER}/${manifest.background.service_worker}`));
  assert.ok(entries.has(`${PACKAGE_FOLDER}/${manifest.action.default_popup}`));
  assert.ok(entries.has(`${PACKAGE_FOLDER}/docs/images/plugin-interface.png`));
  for (const name of entries.keys()) {
    assert.ok(!/\.git|\.test-output|node_modules|tests\/|scripts\//.test(name));
    assert.ok(!name.includes('\\'));
    assert.ok(!name.includes('..'));
  }
  assert.equal(result.checksum, createHash('sha256').update(archive).digest('hex'));
  assert.equal(readFileSync(result.checksumPath, 'utf8'), `${result.checksum}  ${path.basename(result.archivePath)}\n`);
});

test('相同源文件重复打包生成相同字节和校验值', () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'm3u8-repro-'));
  const first = packageExtension({ outputDir: path.join(output, 'first') });
  const second = packageExtension({ outputDir: path.join(output, 'second') });
  assert.deepEqual(readFileSync(first.archivePath), readFileSync(second.archivePath));
  assert.equal(first.checksum, second.checksum);
});

test('版本不一致或错误标签必须在发布前失败', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm3u8-version-'));
  writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
  writeFileSync(path.join(root, 'manifest.json'), '{"version":"0.1.1"}');
  assert.throws(() => packageExtension({ rootDir: root }), /版本必须一致/);
  assert.throws(() => packageExtension({ tag: 'v0.1.1' }), /不一致/);
  assert.throws(() => packageExtension({ tag: '' }), /不一致/);
});

test('发布说明缺失或为空时不能打正式包', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm3u8-notes-'));
  for (const file of ['package.json', 'manifest.json']) copyFileSync(path.join(PROJECT_ROOT, file), path.join(root, file));
  assert.throws(() => packageExtension({ rootDir: root, tag: `v${version}` }), /ENOENT/);
  mkdirSync(path.join(root, 'docs/releases'), { recursive: true });
  writeFileSync(path.join(root, 'docs/releases', `v${version}.md`), ' \n');
  assert.throws(() => packageExtension({ rootDir: root, tag: `v${version}` }), /非空/);
});

test('版本格式符合 Chrome 数字版本规则', () => {
  assert.equal(validateVersion('1.0.0'), '1.0.0');
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-beta', '0.0.0', '65536.0.0', '../1.0.0']) {
    assert.throws(() => validateVersion(version));
  }
});
