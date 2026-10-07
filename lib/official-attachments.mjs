import { inflateRawSync, crc32 } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import iconv from 'iconv-lite';

// Text only: no files, embedded objects, macros, scripts or external URLs are opened.
export const ATTACHMENT_LIMITS = Object.freeze({
  downloadBytes: 6 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  entryBytes: 6 * 1024 * 1024,
  entries: 32,
  documents: 8,
  ratio: 200,
  textChars: 80_000,
  timeoutMs: 8_000,
});

function requireSafe(condition, message = 'Malformed attachment') {
  if (!condition) throw new Error(message);
}

function spend(budget, size) {
  requireSafe(Number.isSafeInteger(size) && size >= 0 && size <= budget.bytes, 'Attachment expansion limit');
  budget.bytes -= size;
}

function inflate(bytes, budget, expectedSize) {
  const maxOutputLength = Math.min(ATTACHMENT_LIMITS.entryBytes, budget.bytes, Math.max(1024, bytes.length * ATTACHMENT_LIMITS.ratio));
  requireSafe(maxOutputLength > 0, 'Attachment expansion limit');
  const result = inflateRawSync(bytes, { maxOutputLength });
  requireSafe(expectedSize == null || result.length === expectedSize, 'ZIP size mismatch');
  spend(budget, result.length);
  return result;
}

// Read the central directory before inflating anything. ZIP64, split/encrypted
// archives, links, traversal and nested archives are deliberately unsupported.
function zipEntries(bytes, budget) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  requireSafe(end >= 0, 'Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  requireSafe(bytes.readUInt32LE(end + 4) === 0 && bytes.readUInt16LE(end + 8) === count, 'Split ZIP is unsupported');
  requireSafe(count <= ATTACHMENT_LIMITS.entries && directoryStart + directorySize === end, 'ZIP directory limit');
  const entries = [];
  const names = new Set();
  let cursor = directoryStart;
  let expanded = 0;
  let previousEnd = 0;
  for (let index = 0; index < count; index += 1) {
    requireSafe(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    requireSafe(cursor + 46 + nameSize + extraSize + commentSize <= end && nameSize <= 1024);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = (flags & 0x800 ? rawName.toString('utf8') : iconv.decode(rawName, 'cp949')).normalize('NFC');
    requireSafe(name && !/[\\\x00-\x1f:]/u.test(name) && !name.startsWith('/') && !name.split('/').includes('..') && !names.has(name), 'Unsafe ZIP name');
    names.add(name);
    requireSafe(!(flags & 0x41) && [0, 8].includes(method) && bytes.readUInt16LE(cursor + 34) === 0, 'Unsupported ZIP encoding');
    requireSafe((bytes.readUInt32LE(cursor + 38) >>> 16 & 0xf000) !== 0xa000, 'ZIP links are unsupported');
    requireSafe(size <= ATTACHMENT_LIMITS.entryBytes && size <= Math.max(1024, compressedSize * ATTACHMENT_LIMITS.ratio), 'ZIP expansion limit');
    expanded += size;
    requireSafe(expanded <= budget.bytes, 'ZIP total expansion limit');
    requireSafe(offset + 30 <= directoryStart && bytes.readUInt32LE(offset) === 0x04034b50);
    const localNameSize = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameSize + bytes.readUInt16LE(offset + 28);
    requireSafe(start + compressedSize <= directoryStart && offset >= previousEnd, 'Overlapping ZIP entries');
    previousEnd = start + compressedSize;
    requireSafe(bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method
      && rawName.equals(bytes.subarray(offset + 30, offset + 30 + localNameSize)), 'ZIP header mismatch');
    if (!(flags & 8)) requireSafe(bytes.readUInt32LE(offset + 18) === compressedSize && bytes.readUInt32LE(offset + 22) === size, 'ZIP size mismatch');
    entries.push({ name, method, size, crc: bytes.readUInt32LE(cursor + 16), bytes: bytes.subarray(start, start + compressedSize) });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  requireSafe(cursor === end);
  return entries;
}

const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const END = 0xfffffffe;
const FREE = 0xffffffff;

// Minimal MS-CFB reader for HWP5 FileHeader and BodyText streams. All chain
// walks are finite, checked against physical input, and charged to a budget.
function cfbStreams(bytes, budget) {
  requireSafe(bytes.length >= 512 && bytes.subarray(0, 8).equals(CFB_SIGNATURE), 'Not an HWP compound file');
  const version = bytes.readUInt16LE(26);
  const shift = bytes.readUInt16LE(30);
  requireSafe(((version === 3 && shift === 9) || (version === 4 && shift === 12))
    && bytes.readUInt16LE(28) === 0xfffe && bytes.readUInt16LE(32) === 6 && bytes.readUInt32LE(56) === 4096, 'Unsupported CFB header');
  const sectorSize = 2 ** shift;
  const sectorCount = Math.floor(bytes.length / sectorSize) - 1;
  requireSafe(sectorCount > 0 && bytes.length % sectorSize === 0);
  const sector = (id) => {
    requireSafe(id >= 0 && id < sectorCount, 'Invalid CFB sector');
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const fatCount = bytes.readUInt32LE(44);
  requireSafe(fatCount > 0 && fatCount <= sectorCount);
  const fatIds = [];
  const addFat = (buffer, length) => {
    for (let i = 0; i < length; i += 4) {
      const id = buffer.readUInt32LE(i);
      if (id !== FREE) fatIds.push(id);
    }
  };
  addFat(bytes.subarray(76, 512), 436);
  const difatCount = bytes.readUInt32LE(72);
  requireSafe(difatCount <= sectorCount);
  let difat = bytes.readUInt32LE(68);
  const difatSeen = new Set();
  for (let i = 0; i < difatCount; i += 1) {
    requireSafe(!difatSeen.has(difat), 'Cyclic CFB DIFAT');
    difatSeen.add(difat);
    const part = sector(difat);
    addFat(part, sectorSize - 4);
    difat = part.readUInt32LE(sectorSize - 4);
  }
  requireSafe((difatCount === 0 || difat === END) && fatIds.length === fatCount && new Set(fatIds).size === fatCount);
  spend(budget, fatCount * sectorSize);
  const fat = Buffer.concat(fatIds.map(sector));
  const chain = (start, table, getSector, unit, size) => {
    requireSafe(size == null || size <= ATTACHMENT_LIMITS.entryBytes, 'CFB stream limit');
    const chunks = [];
    const seen = new Set();
    let id = start;
    while (id !== END) {
      requireSafe(id < table.length / 4 && !seen.has(id), 'Invalid or cyclic CFB chain');
      requireSafe(size == null || chunks.length < Math.ceil(size / unit), 'Overlong CFB chain');
      seen.add(id);
      spend(budget, unit);
      chunks.push(getSector(id));
      id = table.readUInt32LE(id * 4);
    }
    requireSafe(size == null || chunks.length * unit >= size, 'Truncated CFB chain');
    const result = Buffer.concat(chunks);
    return size == null ? result : result.subarray(0, size);
  };
  const directory = chain(bytes.readUInt32LE(48), fat, sector, sectorSize);
  requireSafe(directory.length <= 2048 * 128, 'CFB directory limit');
  const records = [];
  for (let i = 0; i < directory.length; i += 128) {
    const item = directory.subarray(i, i + 128);
    const nameLength = item.readUInt16LE(64);
    const type = item[66];
    requireSafe(!type || (nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0));
    const size = Number(item.readBigUInt64LE(120));
    requireSafe(!type || (Number.isSafeInteger(size) && size <= ATTACHMENT_LIMITS.entryBytes), 'CFB stream limit');
    records.push({ name: item.subarray(0, Math.max(0, nameLength - 2)).toString('utf16le'), type,
      left: item.readUInt32LE(68), right: item.readUInt32LE(72), child: item.readUInt32LE(76), start: item.readUInt32LE(116), size });
  }
  requireSafe(records[0]?.type === 5, 'Missing CFB root');
  const miniCount = bytes.readUInt32LE(64);
  requireSafe(miniCount <= sectorCount);
  const miniFat = miniCount ? chain(bytes.readUInt32LE(60), fat, sector, sectorSize, miniCount * sectorSize) : Buffer.alloc(0);
  const miniStream = records[0].size ? chain(records[0].start, fat, sector, sectorSize, records[0].size) : Buffer.alloc(0);
  const miniSector = (id) => {
    requireSafe((id + 1) * 64 <= miniStream.length, 'Invalid CFB mini sector');
    return miniStream.subarray(id * 64, (id + 1) * 64);
  };
  const paths = new Map();
  const queue = [{ id: records[0].child, parent: '' }];
  const seen = new Set([0]);
  while (queue.length) {
    const { id, parent } = queue.pop();
    if (id === FREE) continue;
    requireSafe(id < records.length && !seen.has(id), 'Invalid CFB directory tree');
    seen.add(id);
    const record = records[id];
    requireSafe([1, 2].includes(record.type) && record.name && !/[\/\\\x00]/u.test(record.name));
    const path = `${parent}${record.name}`;
    requireSafe(!paths.has(path) && path.length < 2048);
    paths.set(path, record);
    queue.push({ id: record.left, parent }, { id: record.right, parent });
    if (record.type === 1) queue.push({ id: record.child, parent: `${path}/` });
  }
  return {
    paths: [...paths.keys()],
    read(path) {
      const record = paths.get(path);
      requireSafe(record?.type === 2, 'Missing HWP stream');
      if (!record.size) return Buffer.alloc(0);
      return record.size < 4096
        ? chain(record.start, miniFat, miniSector, 64, record.size)
        : chain(record.start, fat, sector, sectorSize, record.size);
    },
  };
}

function hwpParagraph(bytes) {
  requireSafe(bytes.length % 2 === 0, 'Invalid HWP text');
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const code = bytes.readUInt16LE(i);
    if (code >= 32) { text += String.fromCharCode(code); i += 2; continue; }
    if (code === 10 || code === 13) text += '\n';
    else if (code === 9 || code === 30 || code === 31) text += ' ';
    // HWP inline/extended controls are eight UTF-16 code units; their payload
    // is binary (not searchable text). Paragraph/end/space controls are one.
    const wide = (code >= 1 && code <= 9) || (code >= 11 && code <= 12) || (code >= 14 && code <= 23);
    const width = wide ? 16 : 2;
    requireSafe(i + width <= bytes.length, 'Truncated HWP control');
    i += width;
  }
  return text;
}

function hwpText(bytes, budget) {
  const cfb = cfbStreams(bytes, budget);
  const header = cfb.read('FileHeader');
  requireSafe(header.length === 256 && header.subarray(0, 17).toString('ascii') === 'HWP Document File' && header[35] === 5, 'Unsupported HWP version');
  const flags = header.readUInt32LE(36);
  requireSafe(!(flags & (2 | 4 | 16 | 256 | 1024)), 'Protected HWP is unsupported');
  const paths = cfb.paths.filter((path) => /^BodyText\/Section\d+$/u.test(path))
    .sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]));
  requireSafe(paths.length > 0 && paths.length <= 64, 'HWP section limit');
  const paragraphs = [];
  let textLength = 0;
  for (const path of paths) {
    const raw = cfb.read(path);
    const data = flags & 1 ? inflate(raw, budget) : raw;
    for (let offset = 0; offset < data.length;) {
      requireSafe(offset + 4 <= data.length, 'Truncated HWP record');
      const record = data.readUInt32LE(offset);
      offset += 4;
      let size = record >>> 20;
      if (size === 0xfff) {
        requireSafe(offset + 4 <= data.length);
        size = data.readUInt32LE(offset); offset += 4;
      }
      requireSafe(offset + size <= data.length, 'Truncated HWP record');
      if ((record & 0x3ff) === 67) {
        const text = hwpParagraph(data.subarray(offset, offset + size));
        textLength += text.length;
        requireSafe(textLength <= ATTACHMENT_LIMITS.textChars, 'HWP text limit');
        paragraphs.push(text);
      }
      offset += size;
    }
  }
  return paragraphs.join('\n').trim();
}

async function documentText(bytes, type, budget) {
  if (type === 'HWP') return hwpText(bytes, budget);
  requireSafe(type === 'PDF' && bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'Unsupported attachment signature');
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false });
  try {
    // PDF parsing also runs in the disposable worker below, with page/time/heap limits.
    const result = await parser.getText({ first: 30 });
    return String(result?.text || '').slice(0, ATTACHMENT_LIMITS.textChars);
  } finally { await parser.destroy().catch(() => {}); }
}

async function parseAttachment(bytes, type, name) {
  requireSafe(bytes.length <= ATTACHMENT_LIMITS.downloadBytes, 'Attachment download limit');
  const budget = { bytes: ATTACHMENT_LIMITS.expandedBytes };
  if (type !== 'ZIP') return { documents: [{ name, text: await documentText(bytes, type, budget) }], skipped: 0 };
  const entries = zipEntries(bytes, budget);
  const documents = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const entryType = entry.name.match(/\.(hwp|pdf)$/iu)?.[1]?.toUpperCase();
    if (!entryType || documents.length >= ATTACHMENT_LIMITS.documents) { skipped += 1; continue; }
    try {
      const data = entry.method === 8 ? inflate(entry.bytes, budget, entry.size) : entry.bytes;
      if (entry.method === 0) spend(budget, data.length);
      requireSafe(data.length === entry.size && crc32(data) === entry.crc, 'ZIP checksum mismatch');
      const text = await documentText(data, entryType, budget);
      requireSafe(documents.reduce((sum, doc) => sum + doc.text.length, 0) + text.length <= ATTACHMENT_LIMITS.textChars, 'Attachment text limit');
      if (text) documents.push({ name: entry.name, text }); else skipped += 1;
    } catch { skipped += 1; }
  }
  return { documents, skipped };
}

export function extractOfficialAttachmentText(bytes, { type, name = '공식 첨부파일', timeoutMs = ATTACHMENT_LIMITS.timeoutMs } = {}) {
  requireSafe(bytes.byteLength <= ATTACHMENT_LIMITS.downloadBytes, 'Attachment download limit');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { officialAttachment: true, bytes, type, name },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release this isolate before the collector starts the next attachment.
      void worker.terminate().then(() => {
        if (error) reject(error); else resolve(result);
      }, (terminationError) => reject(error || terminationError));
    };
    const timer = setTimeout(() => finish(new Error('Attachment parser timeout')), Math.min(timeoutMs, ATTACHMENT_LIMITS.timeoutMs));
    worker.once('message', (message) => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', (error) => finish(error));
    worker.once('exit', () => finish(new Error('Attachment parser exited')));
  });
}

if (!isMainThread && workerData?.officialAttachment) {
  try {
    const result = await parseAttachment(Buffer.from(workerData.bytes), workerData.type, workerData.name);
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ error: String(error?.message || 'Attachment parse failed') }); }
}
