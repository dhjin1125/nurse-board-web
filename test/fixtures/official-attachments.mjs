import { deflateRawSync, crc32 } from 'node:zlib';
import iconv from 'iconv-lite';

// Small, generated CFB/HWP5 documents: exercise actual container/record parsing
// without storing hospital files or requiring Python/office tooling in CI.
export function makeHwp(text, { compressed = true, flags = 0, controlPrefix = Buffer.alloc(0) } = {}) {
  const payload = Buffer.concat([controlPrefix, Buffer.from(text, 'utf16le')]);
  const record = Buffer.alloc(payload.length < 4095 ? 4 : 8);
  record.writeUInt32LE(((Math.min(payload.length, 4095) << 20) | 67) >>> 0);
  if (record.length === 8) record.writeUInt32LE(payload.length, 4);
  const body = compressed ? deflateRawSync(Buffer.concat([record, payload])) : Buffer.concat([record, payload]);
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File');
  fileHeader[35] = 5;
  fileHeader.writeUInt32LE(flags | Number(compressed), 36);
  const miniBody = body.length < 4096;
  const miniUnits = 4 + (miniBody ? Math.ceil(body.length / 64) : 0);
  const miniData = Buffer.alloc(Math.ceil(miniUnits / 8) * 512);
  fileHeader.copy(miniData);
  if (miniBody) body.copy(miniData, 256);
  const miniSectors = miniData.length / 512;
  const regularSectors = miniBody ? 0 : Math.ceil(body.length / 512);
  const sectorCount = 3 + miniSectors + regularSectors;
  if (sectorCount > 128) throw new Error('Fixture too large for one FAT');
  const bytes = Buffer.alloc((sectorCount + 1) * 512);
  bytes.set(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  bytes.writeUInt16LE(0x3e, 24); bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30); bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44); bytes.writeUInt32LE(1, 48); bytes.writeUInt32LE(4096, 56);
  bytes.writeUInt32LE(2, 60); bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(0xff, 76, 512); bytes.writeUInt32LE(0, 76);
  const fat = bytes.subarray(512, 1024); fat.fill(0xff);
  fat.writeUInt32LE(0xfffffffd, 0); fat.writeUInt32LE(0xfffffffe, 4); fat.writeUInt32LE(0xfffffffe, 8);
  const fatChain = (start, length) => {
    for (let n = 0; n < length; n += 1) fat.writeUInt32LE(n + 1 === length ? 0xfffffffe : start + n + 1, (start + n) * 4);
  };
  fatChain(3, miniSectors);
  if (!miniBody) fatChain(3 + miniSectors, regularSectors);
  const entry = (index, name, type, start, size, right = 0xffffffff, child = 0xffffffff) => {
    const dir = bytes.subarray(1024 + index * 128, 1024 + (index + 1) * 128);
    const nameBytes = Buffer.from(`${name}\0`, 'utf16le'); nameBytes.copy(dir);
    dir.writeUInt16LE(nameBytes.length, 64); dir[66] = type; dir[67] = 1;
    dir.writeUInt32LE(0xffffffff, 68); dir.writeUInt32LE(right, 72); dir.writeUInt32LE(child, 76);
    dir.writeUInt32LE(start, 116); dir.writeBigUInt64LE(BigInt(size), 120);
  };
  entry(0, 'Root Entry', 5, 3, miniData.length, 0xffffffff, 1);
  entry(1, 'FileHeader', 2, 0, 256, 2);
  entry(2, 'BodyText', 1, 0, 0, 0xffffffff, 3);
  entry(3, 'Section0', 2, miniBody ? 4 : 3 + miniSectors, body.length);
  const miniFat = bytes.subarray(1536, 2048); miniFat.fill(0xff);
  for (let n = 0; n < miniUnits; n += 1) miniFat.writeUInt32LE(n === 3 || n + 1 === miniUnits ? 0xfffffffe : n + 1, n * 4);
  miniData.copy(bytes, 2048);
  if (!miniBody) body.copy(bytes, (4 + miniSectors) * 512);
  return bytes;
}

export function makeZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.cp949 ? iconv.encode(entry.name, 'cp949') : Buffer.from(entry.name);
    const data = entry.bytes || Buffer.from('unsupported');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = (entry.cp949 ? 0 : 0x800) | (entry.flags || 0);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.declaredSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(entry.crc ?? crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(entry.attributes || 0, 38); central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, compressed); directory.push(central); offset += local.length + compressed.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

export function makePdf(text = 'Nurse role description') {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

export const surgeryText = '직무소개서\n세부직무\n외과 병동의 전담간호사 업무\n업무내용\n처치 보조와 환자 교육\n직무요건\n간호사 면허, 외과 진료지원 경력\n비고\n부서 이동 가능';
export const heartText = '직무소개서\n세부직무\n심장·뇌혈관조영실 간호 업무\n업무내용\n검사와 시술 간호\n직무요건\n간호사 면허\n비고\n응급 온콜(On-call)근무 및 시차 출퇴근 발생 가능';
export const recruiterHtml = `<table><tr><th>접수기간</th><td>2026.09.10 09:00 ~ 2026.09.21 23:59</td></tr></table>
<div id="viewSmartEditorContent"><p>1. 모집분야 및 응시요건</p>
<table><tr><th colspan="2">모집분야</th><th>응시요건</th></tr>
<tr><td rowspan="2">간호직</td><td>외과</td><td>종합병원 근무 경력 3년 이상, 간호사 면허</td></tr>
<tr><td>심장혈관센터</td><td>종합병원 근무 경력 1년 이상, 간호사 면허</td></tr></table>
<p>2. 기타</p><p>병원 사정에 따라 근무형태 변경 가능</p></div>
<a class="fileWrapperView" href="/mrs2/attachFile/downloadFile?fileUid=roles.zip">직무소개서.zip</a>`;
