/**
 * 构建多语言码表数据文件。
 *
 * 数据来源：
 *  - 中文电码: npm 包 chinese-telegraph-code (源自 Unicode Unihan)
 *      kMainlandTelegraph -> 大陆版 (cn.csv, 7078 字)
 *      kTaiwanTelegraph   -> 台湾/香港版 (tw.csv, 9024 字)
 *
 * 运行: npx tsx scripts/build-codes.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'src', 'core', 'codebooks', 'generated');
const NODE_MODULES = join(ROOT, 'node_modules');

interface CtcRow {
  code: string;
  character: string;
  codepoint: string;
}

/** 读取 chinese-telegraph-code 包中的 CSV */
function readCtcCsv(file: string): CtcRow[] {
  const p = join(NODE_MODULES, 'chinese-telegraph-code', 'data', file);
  if (!existsSync(p)) {
    throw new Error(`找不到 ${p}，请先执行: npm i chinese-telegraph-code`);
  }
  const text = readFileSync(p, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const rows: CtcRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const character = parts[1].trim();
    if (!code || !character) continue;
    rows.push({ code, character, codepoint: parts[2]?.trim() ?? '' });
  }
  return rows;
}

/** 生成 TypeScript 码表模块 */
function emitCodebookModule(
  filename: string,
  id: string,
  name: string,
  displayName: string,
  system: 'morse' | 'telegraph',
  source: string,
  rows: CtcRow[],
  gaps?: { char: number; group?: number; word: number },
) {
  const entries: Record<string, string> = {};
  for (const r of rows) {
    // 码表按码值排序，保证生成的 JSON 稳定
    if (!(r.character in entries)) entries[r.character] = r.code;
  }
  const sorted = Object.keys(entries).sort();
  const body = sorted.map((ch) => `  ${JSON.stringify(ch)}: ${JSON.stringify(entries[ch])},`).join('\n');

  const gapLine = gaps
    ? `  gaps: { char: ${gaps.char}, group: ${gaps.group ?? 'undefined'}, word: ${gaps.word} },\n`
    : '';

  const ts = `/* eslint-disable */
// 自动生成，请勿手工编辑。数据来源: ${source}
/* eslint-enable */
import type { Codebook } from '../../types';
import { buildCodebook } from '../../codebook';

export const ${filename.toUpperCase().replace(/[^A-Z0-9]/g, '_')}: Codebook = buildCodebook({
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  displayName: ${JSON.stringify(displayName)},
  system: ${JSON.stringify(system)},
  direction: 'bidirectional',
  version: '1.0.0',
  source: ${JSON.stringify(source)},
  license: 'MIT',
${gapLine}  entries: {
${body}
  },
});
`;
  const outPath = join(OUT_DIR, `${filename}.ts`);
  writeFileSync(outPath, ts, 'utf8');
  console.log(`  ✓ ${filename}.ts  (${sorted.length} 字符)`);
  return sorted.length;
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log('构建多语言码表...');

  const cn = readCtcCsv('cn.csv');
  console.log(`  读取 cn.csv: ${cn.length} 条`);
  emitCodebookModule(
    'telegraph-cn',
    'zh-CN',
    'Chinese Telegraph Code (Mainland)',
    '中文电码（大陆）',
    'telegraph',
    'Unicode Unihan kMainlandTelegraph (via npm chinese-telegraph-code, MIT)',
    cn,
    { char: 3, group: 5, word: 9 },
  );

  const tw = readCtcCsv('tw.csv');
  console.log(`  读取 tw.csv: ${tw.length} 条`);
  emitCodebookModule(
    'telegraph-tw',
    'zh-TW',
    'Chinese Telegraph Code (Taiwan/HK)',
    '中文电码（台湾/香港）',
    'telegraph',
    'Unicode Unihan kTaiwanTelegraph (via npm chinese-telegraph-code, MIT)',
    tw,
    { char: 3, group: 5, word: 9 },
  );

  console.log('完成。');
}

main();
