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
 * （首帧 = session 头一行，其后为事件帧，帧带 checksum）。
 *
 * 解帧语义（2026-10-25 Round 1 安全评审 P1-1 修正；本机 node v24.13.1 矩阵探针实测）：
 *   本文件历史注释「一次性 zstdDecompressSync 恒止于第一帧」**已被实测推翻**——
 *   当某帧解码输出恰好按 16KiB 内部块对齐收尾时（如 flat 内容 16384/32768/49152/131072
 *   字节），sync 解码循环会越过帧边界把后续拼接帧一并解出（实测贪读 2×，输入耗尽才停）；
 *   未对齐尺寸（16385/40960/55890）单帧止。后果：按候选偏移逐帧解压再拼接的做法会把
 *   被吞帧的内容**重复计入输出**（真实 320 日志实测 3 文件 5 重复行）。
 *   故本模块在逐候选解压后按帧头 Frame_Content_Size（RFC 8878；zstdCompressSync 写端
 *   恒携带）把贪读输出**截断回单帧精确内容**（帧边界判定），并叠加两道 fail-closed 防护：
 *   ① 解压预算上限（帧数/单帧/累计，超限显式拒绝——构造文件 3430B 即可放大至数百 MiB）；
 *   ② 去重行防护（跨帧重复行 = 吞并痕迹，计数上报供消费方 fail-closed，不再静默膨胀）。
 *   已知残余：无 FCS 字段的帧（流式写端）无法精确定界，靠去重行防护兜底；
 *   node 的 maxOutputLength 选项对 zstd sync 解压**不生效**（实测静默忽略），
 *   预算只能事后校验——单次调用的内存尖峰不受此上限约束（输入规模 × 压缩比）。
 *
 * 用法：
 *   import { zstdRead, zstdReadInfo, zstdReadMultiFrame, countFrames, dedupLines,
 *            parseFrameContentSize, decompressAllFrames } from './zstd-read.mjs'
 *   node tools/zstd-read.mjs <file.zstd>          # 打印解压全文（调试用；重复行去重并告警）
 *   node tools/zstd-read.mjs <file.zstd> --info   # 帧数/行数/字节概要（单趟解压复用）
 */
import { readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// fail-closed 预算上限（2026-10-25 security R1 P1-1；可用 opts 覆盖以便注入必红自测）
export const MAX_FRAMES = 65536               // 单文件帧候选数上限
export const MAX_FRAME_BYTES = 64 * 1024 * 1024   // 单帧解压内容上限（会话日志单帧远低于此）
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024  // 单文件累计解压总量上限

/** 扫描 buffer 内 Frame_Magic 候选偏移（升序；含压缩数据内的假阳性）。 */
export function findFrameCandidates(buf) {
  const out = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i)
  }
  return out
}

/**
 * 解析帧头 Frame_Content_Size（RFC 8878）；无 FCS 字段（流式写端）返回 null。
 * zstdCompressSync 写端恒携带 FCS（2026-10-25 矩阵探针实测：checksum 开关/内容形态/尺寸全组合命中）。
 */
export function parseFrameContentSize(buf, off = 0) {
  if (!Number.isInteger(off) || off < 0 || buf.length < off + 5) return null
  if (buf[off] !== MAGIC[0] || buf[off + 1] !== MAGIC[1] || buf[off + 2] !== MAGIC[2] || buf[off + 3] !== MAGIC[3]) return null
  const fhd = buf[off + 4]
  const fcsFlag = fhd >> 6              // bits 7-6
  const singleSeg = (fhd >> 5) & 1      // bit 5
  const dictFlag = fhd & 3              // bits 1-0
  let pos = off + 5
  if (!singleSeg) pos += 1                                  // Window_Descriptor
  pos += [0, 1, 2, 4][dictFlag]                             // Dictionary_ID
  const size = singleSeg ? (fcsFlag === 0 ? 1 : 1 << fcsFlag) : (fcsFlag === 0 ? 0 : 1 << fcsFlag)
  if (size === 0 || buf.length < pos + size) return null
  let v = 0
  for (let i = 0; i < size; i++) v += buf[pos + i] * 2 ** (8 * i)
  if (size === 2) v += 256              // RFC 8878：2 字节域表示 值+256
  return v
}

/**
 * 去重行防护（2026-10-25 security R1 P1-1）：跨帧重复行是「帧边界吞并」痕迹。
 * 保留首现、序不变；空行不去重（不影响 JSONL 语义）。返回 { text, dupLines }。
 * 消费方（measure-decay）对 dupLines > 0 fail-closed——计数上报而非静默吞掉。
 */
export function dedupLines(text) {
  const lines = String(text).split('\n')
  const seen = new Set()
  const out = []
  let dups = 0
  for (const line of lines) {
    if (line === '') { out.push(line); continue }
    if (seen.has(line)) { dups++; continue }
    seen.add(line)
    out.push(line)
  }
  return { text: out.join('\n'), dupLines: dups }
}

/**
 * 逐帧解压：帧边界判定（FCS 截断）+ fail-closed 预算。
 * 返回 { parts, frames, truncated }：parts[i] = 第 i 个成功帧的精确内容；
 * frames = 成功帧数；truncated = 触发过贪读截断的帧数。
 * 超任一预算（帧候选数/单帧/累计）抛 Error（fail-closed，含恢复指引），绝不降级续跑。
 */
export function decompressAllFrames(buf, opts = {}) {
  const maxFrames = opts.maxFrames ?? MAX_FRAMES
  const maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES
  const cands = findFrameCandidates(buf)
  if (cands.length > maxFrames) {
    throw new Error(`帧候选 ${cands.length} > 上限 ${maxFrames}：疑似构造输入，拒绝处理（fail-closed；复跑前请核对该文件来源）`)
  }
  const parts = []
  let total = 0
  let frames = 0
  let truncated = 0
  for (const off of cands) {
    let out
    try { out = zstdDecompressSync(buf.subarray(off)) } catch { continue } // 假 magic：丢弃
    const fcs = parseFrameContentSize(buf, off)
    if (fcs !== null) {
      if (out.length < fcs) {
        throw new Error(`帧@${off} 解压输出 ${out.length} < 帧头声明 ${fcs}：数据完整性异常，拒绝处理（fail-closed）`)
      }
      if (out.length > fcs) {
        // 贪读吞并：sync 解码越过帧边界带出了后续帧内容，按声明尺寸截断回单帧精确内容
        out = out.subarray(0, fcs)
        truncated++
      }
    }
    if (out.length > maxFrameBytes) {
      throw new Error(`帧@${off} 解压 ${out.length} 超单帧上限 ${maxFrameBytes}：疑似解压炸弹，拒绝处理（fail-closed）`)
    }
    total += out.length
    if (total > maxTotalBytes) {
      throw new Error(`累计解压 ${total} 超总量上限 ${maxTotalBytes}：疑似解压炸弹，拒绝处理（fail-closed；如确为合法大日志请分片处理）`)
    }
    frames++
    parts.push(out)
  }
  return { parts, frames, truncated }
}

/**
 * 多帧循环解压 → { text, frames, truncated, dupLines }（text 已去重行）。
 * --info 单趟复用（旧实现 countFrames + 全文解压双重解压，2026-10-25 P2-2 收敛）。
 */
export function zstdReadInfo(buf, opts) {
  const { parts, frames, truncated } = decompressAllFrames(buf, opts)
  const raw = Buffer.concat(parts).toString('utf-8')
  const { text, dupLines } = dedupLines(raw)
  return { text, frames, truncated, dupLines }
}

/** 多帧循环解压 → 完整文本（UTF-8，已去重行；API 兼容保留）。 */
export function zstdReadMultiFrame(buf, opts) {
  return zstdReadInfo(buf, opts).text
}

/** 实际解压成功的帧数（= magic 候选数 − 假阳性失败数）。 */
export function countFrames(buf, opts) {
  return decompressAllFrames(buf, opts).frames
}

/** 读一个 zstd 日志文件为全文（按 magic 识别，不依赖扩展名）。 */
export function zstdRead(zpath, opts) {
  return zstdReadMultiFrame(readFileSync(zpath), opts)
}

function main() {
  const args = process.argv.slice(2)
  const zpath = args[0]
  if (!zpath) {
    console.error('用法: node tools/zstd-read.mjs <file.zstd> [--info]')
    process.exitCode = 1
    return
  }
  statSync(zpath) // 不存在则抛错退出
  const buf = readFileSync(zpath)
  let info
  try {
    info = zstdReadInfo(buf) // 单趟解压：--info 与全文输出共用（P2-2）
  } catch (e) {
    console.error(`[zstd-read] ${e && e.message || e}`)
    process.exitCode = 1
    return
  }
  if (args[1] === '--info') {
    const cands = findFrameCandidates(buf).length
    const lines = info.text.split('\n').filter(Boolean).length
    console.log(`file=${zpath} bytes=${buf.length} magicCandidates=${cands} frames=${info.frames} greedyTruncated=${info.truncated} dedupLines=${info.dupLines} lines=${lines}`)
  } else {
    process.stdout.write(info.text)
  }
  if (info.dupLines > 0) {
    console.error(`[zstd-read] warn: 检测并去除 ${info.dupLines} 条跨帧重复行（帧边界吞并痕迹）——读数可能失真，请核对该文件来源`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
