import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTACHMENT_LIMITS, extractOfficialAttachmentText } from '../lib/official-attachments.mjs';
import { makeHwp, makeZip, makePdf, surgeryText, heartText } from './fixtures/official-attachments.mjs';

const extract = (bytes, type = 'HWP', options = {}) => extractOfficialAttachmentText(bytes, { type, name: 'fixture', ...options });

test('HWP5 compressed and plain mini streams preserve paragraphs and skip control payload', async () => {
  const control = Buffer.alloc(16); control.writeUInt16LE(2); control.write('BINARY', 2); control.writeUInt16LE(2, 14);
  for (const compressed of [true, false]) {
    const result = await extract(makeHwp(surgeryText, { compressed, controlPrefix: control }));
    assert.equal(result.documents[0].text, surgeryText);
    assert.doesNotMatch(result.documents[0].text, /BINARY/u);
  }
});

test('HWP5 regular FAT streams and extended record sizes are supported', async () => {
  const text = `${surgeryText}\n`.repeat(25);
  const result = await extract(makeHwp(text, { compressed: false }));
  assert.equal(result.documents[0].text, text.trim());
});

test('ZIP reads both HWP roles with Korean legacy filenames; never descends into nested ZIP', async () => {
  const result = await extract(makeZip([
    { name: '직무소개서(외과).hwp', bytes: makeHwp(surgeryText), cp949: true },
    { name: '직무소개서(심장).hwp', bytes: makeHwp(heartText), method: 0 },
    { name: 'nested.zip', bytes: makeZip([{ name: 'hidden.hwp', bytes: makeHwp('HIDDEN') }]) },
  ]), 'ZIP');
  assert.deepEqual(result.documents.map((doc) => doc.text), [surgeryText, heartText]);
  assert.equal(result.documents[0].name, '직무소개서(외과).hwp');
  assert.equal(result.skipped, 1);
});

test('PDF text extraction still works, including inside ZIP', async () => {
  const bytes = makePdf();
  assert.match((await extract(bytes, 'PDF')).documents[0].text, /Nurse role description/);
  assert.match((await extract(makeZip([{ name: 'notice.pdf', bytes }]), 'ZIP')).documents[0].text, /Nurse role description/);
});

test('untrusted signatures, protected HWP, FAT/miniFAT cycles and huge declared streams fail closed', async () => {
  await assert.rejects(extract(Buffer.from('<html>not a PDF</html>'), 'PDF'), /signature/);
  for (const flags of [2, 4, 16, 256, 1024]) await assert.rejects(extract(makeHwp(surgeryText, { flags })), /Protected/);
  const fatCycle = makeHwp(surgeryText); fatCycle.writeUInt32LE(1, 512 + 4);
  await assert.rejects(extract(fatCycle), /cyclic/);
  const miniCycle = makeHwp(surgeryText); miniCycle.writeUInt32LE(0, 1536);
  await assert.rejects(extract(miniCycle), /cyclic/);
  const directoryCycle = makeHwp(surgeryText); directoryCycle.writeUInt32LE(1, 1024 + 128 + 72);
  await assert.rejects(extract(directoryCycle), /directory tree/);
  const huge = makeHwp(surgeryText); huge.writeBigUInt64LE(2n ** 50n, 1024 + 3 * 128 + 120);
  await assert.rejects(extract(huge), /stream limit/);
  await assert.rejects(extract(makeHwp('A'.repeat(300_000))), /larger|limit|buffer/i);
});

test('ZIP rejects traversal, links, encryption, entry counts and declared/actual inflation bombs', async () => {
  const bytes = makeHwp(surgeryText);
  for (const entry of [
    { name: '../outside.hwp', bytes }, { name: '/outside.hwp', bytes },
    { name: 'link.hwp', bytes, attributes: (0xa000 << 16) >>> 0 },
    { name: 'encrypted.hwp', bytes, flags: 1 },
    { name: 'huge.hwp', bytes, declaredSize: 0xffffffff },
    { name: 'bomb.hwp', bytes: Buffer.alloc(1024 * 1024) },
  ]) await assert.rejects(extract(makeZip([entry]), 'ZIP'));
  await assert.rejects(extract(makeZip(Array.from({ length: 33 }, (_, i) => ({ name: `${i}.hwp`, bytes }))), 'ZIP'), /directory limit/);
  const lyingBomb = makeZip([{ name: 'bomb.hwp', bytes: Buffer.alloc(1024 * 1024), declaredSize: 1024 }]);
  assert.deepEqual(await extract(lyingBomb, 'ZIP'), { documents: [], skipped: 1 });
});

test('ZIP corruption is isolated to its member and limits document count', async () => {
  const bytes = makeHwp(surgeryText);
  const result = await extract(makeZip([
    { name: 'corrupt.hwp', bytes, crc: 123 },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `${i}.hwp`, bytes })),
  ]), 'ZIP');
  assert.equal(result.documents.length, ATTACHMENT_LIMITS.documents);
  assert.equal(result.skipped, 3);
});

test('worker deadline and input size are enforced', async () => {
  await assert.rejects(extract(makeHwp(surgeryText), 'HWP', { timeoutMs: 1 }), /timeout/);
  assert.throws(() => extract(Buffer.alloc(ATTACHMENT_LIMITS.downloadBytes + 1)), /download limit/);
});
