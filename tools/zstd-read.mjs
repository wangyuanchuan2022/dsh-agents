#!/usr/bin/env node
/**
 * zstd-read.mjs — DSH 会话日志 zstd 多帧解压读取器。
 *
 * 移植自：yjh051108/dsh-routing-suite main@1952733（MIT License）
 *   - graded/scripts/zstd-read.mjs（node:zlib 与写端同栈解压，7z 兼容不稳）
 *   - graded/scripts/fix-ids.mjs（多帧先例：Node zstdDecompressSync 只解第一帧）
 *   上游：https://github.com/yjh051108/dsh-routing-suite/tree/1952733/graded/scripts
 *
 * 宿主写端格式（本机 2026-10-25 实测）：session.v4.jsonl.zstd 为多帧拼接 zstd 流
 * （首帧 = session 头一行，其后为事件帧，帧带 checksum）。Node 的一次性
 * zstdDecompressSync 与流式 createZstdDecompress 实测均止于第一帧——
 * 故本模块按上游 fix-ids.mjs「循环解帧」先例实现：扫描 Frame_Magic
 * （0x28 B5 2F FD）候选偏移，逐个尝试解压：失败候选（压缩数据内的
 * 假 magic，帧带 checksum 几乎必败）丢弃，成功者按偏移升序拼接还原原流。
 *
 * 用法：
 *   import { zstdRead, zstdReadMultiFrame, countFrames } from './zstd-read.mjs'
 *   node tools/zstd-read.mjs <file.zstd>          # 打印解压全文（调试用）
 *   node tools/zstd-read.mjs <file.zstd> --info   # 帧数/行数/字节概要
 */
import { readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 扫描 buffer 内 Frame_Magic 候选偏移（升序；含压缩数据内的假阳性）。 */
export function findFrameCandidates(buf) {
  const out = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i)
  }
  return out
}

/** 实际解压成功的帧数（= magic 候选数 − 假阳性失败数）。 */
export function countFrames(buf) {
  let n = 0
  for (const off of findFrameCandidates(buf)) {
    try { zstdDecompressSync(buf.subarray(off)); n++ } catch { /* 假 magic：丢弃 */ }
  }
  return n
}

/**
 * 多帧循环解压 → 完整文本（UTF-8）。
 * 与上游 zstd-read.mjs 的单帧实现不同：此处按 fix-ids.mjs 先例做逐帧循环解压。
 */
export function zstdReadMultiFrame(buf) {
  const parts = []
  for (const off of findFrameCandidates(buf)) {
    try { parts.push(zstdDecompressSync(buf.subarray(off))) } catch { /* 假 magic：丢弃 */ }
  }
  return Buffer.concat(parts).toString('utf-8')
}

/** 读一个 zstd 日志文件为全文（按 magic 识别，不依赖扩展名）。 */
export function zstdRead(zpath) {
  return zstdReadMultiFrame(readFileSync(zpath))
}

function main() {
  const args = process.argv.slice(2)
  const zpath = args[0]
  if (!zpath) {
    console.error('用法: node tools/zstd-read.mjs <file.zstd> [--info]')
    process.exit(1)
  }
  statSync(zpath) // 不存在则抛错退出
  const buf = readFileSync(zpath)
  if (args[1] === '--info') {
    const cands = findFrameCandidates(buf).length
    const frames = countFrames(buf)
    const text = zstdReadMultiFrame(buf)
    const lines = text.split('\n').filter(Boolean).length
    console.log(`file=${zpath} bytes=${buf.length} magicCandidates=${cands} frames=${frames} lines=${lines}`)
  } else {
    process.stdout.write(zstdReadMultiFrame(buf))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
