import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLikelyBinary, MAX_EDIT_FILE_BYTES, encodeTextFile, atomicWriteFile } from '../lib/fs-ops.js'

test('MAX_EDIT_FILE_BYTES:上限 2MB', () => {
  assert.equal(MAX_EDIT_FILE_BYTES, 2 * 1024 * 1024)
})

test('isLikelyBinary:文本判定', () => {
  assert.equal(isLikelyBinary(Buffer.from('hello world\n中文文本')), false)
  assert.equal(isLikelyBinary(Buffer.from('')), false)
  // BOM 开头的 UTF-8 是文本
  assert.equal(isLikelyBinary(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), false)
})

test('isLikelyBinary:NUL 字节即二进制', () => {
  assert.equal(isLikelyBinary(Buffer.from([0x61, 0x00, 0x62])), true)
  assert.equal(isLikelyBinary(Buffer.from([0x00])), true)
})

test('isLikelyBinary:高比例控制字符判二进制', () => {
  // 256 字节里 7 个控制字符(超 2%)→ 二进制(UTF-16 或其他二进制形态)
  const buf = Buffer.alloc(256, 0x41)
  for (let i = 0; i < 7; i++) buf[i * 30] = 0x02
  assert.equal(isLikelyBinary(buf), true)
  // 少量 \t \n \r 不算(文本正常成员)
  const text = Buffer.alloc(256, 0x41)
  text[0] = 0x09
  text[1] = 0x0a
  text[2] = 0x0d
  assert.equal(isLikelyBinary(text), false)
})

test('encodeTextFile:utf8 有效则解码', () => {
  const decoded = encodeTextFile(Buffer.from('中文内容\nsecond', 'utf8'))
  assert.equal(decoded, '中文内容\nsecond')
})

test('encodeTextFile:非法 utf8(乱码)返回 null', () => {
  // 0xff 单独出现不是合法 UTF-8 序列
  assert.equal(encodeTextFile(Buffer.from([0xff, 0xfe, 0x61])), null)
})

test('atomicWriteFile:覆盖写 + 不留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-atomic-'))
  try {
    const target = join(dir, 'a.txt')
    await writeFile(target, 'old', 'utf8')
    await atomicWriteFile(target, 'new content\n中文')
    assert.equal(await readFile(target, 'utf8'), 'new content\n中文')
    const leftovers = (await readdir(dir)).filter((n) => n.includes('.dshw-tmp-'))
    assert.deepEqual(leftovers, [])
    // 新路径(父目录已存在)也可写
    await atomicWriteFile(join(dir, 'b.txt'), 'x')
    assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFile:写失败不残留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-atomic2-'))
  try {
    // 目录当写目标:writeFile 必败,验证临时文件被清理
    await mkdir(join(dir, 'sub'))
    await assert.rejects(() => atomicWriteFile(join(dir, 'sub'), 'x'))
    const leftovers = (await readdir(dir)).filter((n) => n.includes('.dshw-tmp-'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
