'use strict';

// 生成 Windows 应用图标 assets/icon.ico（内含多尺寸 PNG）。
// ICO 容器结构：ICONDIR(6B) + 每个尺寸一个 ICONDIRENTRY(16B) + 依次排列的图片数据。
// 采用 PNG 压缩条目（Windows Vista+ 支持），避免手写 BMP/DIB，同样无需外部依赖。

const fs = require('fs');
const path = require('path');
const { makePngBuffer } = require('./make-icon');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(sizes) {
  const images = sizes.map((s) => makePngBuffer(s));

  const count = sizes.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: 1 = icon
  dir.writeUInt16LE(count, 4); // image count

  const ENTRY_SIZE = 16;
  let offset = 6 + ENTRY_SIZE * count;
  const entries = [];

  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    const data = images[i];
    const e = Buffer.alloc(ENTRY_SIZE);
    e[0] = size >= 256 ? 0 : size; // width: 0 表示 256
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; // color count (PNG: 0)
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8); // data size
    e.writeUInt32LE(offset, 12); // data offset
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([dir, ...entries, ...images]);
}

const ico = buildIco(SIZES);
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log(
  `[make-winicon] 已生成 Windows 图标: ${outPath} (${ico.length} bytes, 尺寸: ${SIZES.join('/')})`
);
