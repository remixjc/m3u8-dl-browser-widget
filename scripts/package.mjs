import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PACKAGE_FOLDER = 'm3u8-download-helper';
export const RELEASE_FILES = [
  'manifest.json', 'background.js', 'core.js', 'download-bridge.js', 'page-prompt.js',
  'popup.html', 'popup.css', 'popup.js', 'README.md', 'docs/images/plugin-interface.png',
];

export function validateVersion(value) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) ||
      value.split('.').some(part => Number(part) > 65535) || value === '0.0.0') {
    throw new Error('版本必须为 Chrome 支持的三段数字版本，例如 1.0.0，各段不超过 65535。');
  }
  return value;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP32 + DEFLATE，固定文件顺序、权限和时间戳，生成可复现的跨平台安装包。
function zipFiles(entries) {
  const localParts = [];
  const directoryParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directoryParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export function packageExtension({ rootDir = PROJECT_ROOT, outputDir = path.join(rootDir, 'dist'), tag } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const version = validateVersion(pkg.version);
  if (manifest.version !== version) throw new Error('package.json 与 manifest.json 的版本必须一致。');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`标签 ${tag} 与插件版本 v${version} 不一致。`);
  if (tag !== undefined) {
    const notes = path.join(rootDir, 'docs', 'releases', `${tag}.md`);
    if (!readFileSync(notes, 'utf8').trim()) throw new Error('正式发布需要非空的版本说明。');
  }
  for (const file of [manifest.background?.service_worker, manifest.action?.default_popup]) {
    if (!RELEASE_FILES.includes(file)) throw new Error(`manifest 引用的运行文件未纳入安装包：${file}`);
  }
  const entries = RELEASE_FILES.map(file => {
    const target = path.join(rootDir, file);
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error(`打包源必须是普通文件：${file}`);
    let data = readFileSync(target);
    if (!file.endsWith('.png')) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
    return { name: `${PACKAGE_FOLDER}/${file}`, data };
  });
  const archive = zipFiles(entries);
  const filename = `${PACKAGE_FOLDER}-v${version}.zip`;
  const checksum = createHash('sha256').update(archive).digest('hex');
  mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, filename);
  const checksumPath = `${archivePath}.sha256`;
  writeFileSync(archivePath, archive);
  writeFileSync(checksumPath, `${checksum}  ${filename}\n`);
  return { version, archivePath, checksumPath, checksum, files: entries.map(entry => entry.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--tag')) throw new Error('用法：node scripts/package.mjs [--tag v1.0.0]');
    const result = packageExtension({ tag: args[1] });
    console.log(`ZIP: ${result.archivePath}\nSHA256: ${result.checksumPath}\n${result.checksum}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
