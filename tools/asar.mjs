import fs from 'node:fs';
import path from 'node:path';

const asarPath = process.env.ASAR_PATH || 'D:/Deepseek/resources/app.asar';

export function readHeader() {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    return { header: JSON.parse(jsonBuf.toString('utf8')), base: 8 + headerSize, fd };
  } finally {
    fs.closeSync(fd);
  }
}

export function walk(node, prefix = '') {
  const out = [];
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (entry.files) out.push(...walk(entry, p));
    else out.push({ path: p, size: entry.size, offset: entry.offset, unpacked: entry.unpacked });
  }
  return out;
}

export function readFile(entry, base) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { header, base } = readHeader();
  const cmd = process.argv[2];
  if (cmd === 'list') {
    const match = process.argv[3] || '';
    const entries = walk(header).filter((e) => e.path.includes(match));
    console.log(entries.map((e) => `${e.size}\t${e.path}`).join('\n'));
  } else if (cmd === 'cat') {
    const target = process.argv[3];
    const entry = walk(header).find((e) => e.path === target);
    if (!entry) {
      console.error('not found: ' + target);
      process.exit(2);
    }
    process.stdout.write(readFile(entry, base));
  } else if (cmd === 'extract') {
    const prefix = process.argv[3];
    const dest = process.argv[4];
    const entries = walk(header).filter((e) => e.path.startsWith(prefix));
    for (const entry of entries) {
      if (entry.offset == null || entry.unpacked) {
        console.error('skip (unpacked/no offset): ' + entry.path);
        continue;
      }
      const rel = entry.path.slice(prefix.length).replace(/^\/+/, '');
      const out = path.join(dest, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, readFile(entry, base));
    }
    console.log(`extracted ${entries.length} files to ${dest}`);
  } else {
    console.error('usage: asar.mjs list <substr> | cat <exact path> | extract <prefix> <dest>');
    process.exit(1);
  }
}
