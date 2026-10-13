#!/usr/bin/env node
// 固化 grammar wasm 重取流程：下载 tree-sitter-javascript tarball → 解包取 wasm →
// sha256 硬断言（不匹配 exit 1，不落盘）→ 校验通过后写入 lib/advisor/grammars/。
// 用法：node scripts/fetch-grammar-wasm.mjs
// 出网走 npm 自身 fetch（本机 curl/Invoke-WebRequest 走代理不可用，见 agent-out/treesitter-deps-research.md 节 4.1）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'tree-sitter-javascript';
const VERSION = '0.25.0';
const EXPECTED_SHA256 = '5FB488D0CABB4775A594BAB85682DE5AD6CE83C0D6AC997A9F82DD084D571240';
const EXPECTED_BYTES = 411770;
const WASM_IN_TARBALL = 'package/tree-sitter-javascript.wasm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(repoRoot, 'lib', 'advisor', 'grammars');
const dest = path.join(destDir, `${PKG}.wasm`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-grammar-wasm-'));
try {
  const tgz = path.join(tmp, `${PKG}-${VERSION}.tgz`);
  console.error(`[fetch] npm pack ${PKG}@${VERSION} -> ${tgz}`);
  execFileSync('npm', ['pack', `${PKG}@${VERSION}`, '--pack-destination', tmp, '--ignore-scripts',
    // npm 默认缓存目录在工作区外（沙箱内 EPERM），强制走仓内 cache（落在 gitignored 的 agent-out/ 下，避免污染工作树）
    '--cache', path.join(repoRoot, 'agent-out', '.npm-cache-grammar')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (!fs.existsSync(tgz)) {
    console.error(`[fetch] FAIL: tarball not found at ${tgz}`);
    process.exit(1);
  }
  execFileSync('tar', ['-xzf', tgz, '-C', tmp, WASM_IN_TARBALL], { stdio: 'inherit' });
  const wasmPath = path.join(tmp, WASM_IN_TARBALL);
  if (!fs.existsSync(wasmPath)) {
    console.error(`[fetch] FAIL: ${WASM_IN_TARBALL} not found inside tarball`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(wasmPath);
  const sha = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  console.error(`[fetch] bytes = ${bytes.length}`);
  console.error(`[fetch] sha256 = ${sha}`);
  if (sha !== EXPECTED_SHA256) {
    console.error(`[fetch] FAIL: sha256 mismatch (expected ${EXPECTED_SHA256}). Refusing to write.`);
    process.exit(1);
  }
  if (bytes.length !== EXPECTED_BYTES) {
    console.error(`[fetch] FAIL: byte length mismatch (expected ${EXPECTED_BYTES}). Refusing to write.`);
    process.exit(1);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, bytes);
  console.error(`[fetch] OK: wrote ${dest}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
