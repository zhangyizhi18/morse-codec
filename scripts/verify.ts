/**
 * 核心库验证脚本 —— 不依赖 UI / 浏览器 API，纯 Node 环境下运行。
 *
 * 用法:
 *   npx tsx scripts/verify.ts              # 跑完整验证矩阵
 *   npx tsx scripts/verify.ts --quick      # 只跑基础往返
 *   npx tsx scripts/verify.ts --codebook zh-CN
 */
import {
  CODEBOOKS,
  getCodebook,
  encodeText,
  decodeAudio,
  renderTimeline,
  encodeWav,
  decodeWav,
  validateCodebook,
  estimateWpm,
  type Codebook,
  type EncodeOptions,
} from '../src/core';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const codebookArg = args.includes('--codebook')
  ? args[args.indexOf('--codebook') + 1]
  : undefined;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`${C.green}  ✓${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
  } else {
    fail++;
    console.log(`${C.red}  ✗${C.reset} ${name}${detail ? ` ${C.yellow}${detail}${C.reset}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${C.bold}${C.cyan}▌${title}${C.reset}`);
}

/** 加白噪声（确定性 PRNG，保证结果可复现） */
function addNoise(buf: Float32Array, amp: number, seed = 42): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = buf[i] + ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

interface RoundTrip {
  text: string;
  morse: string;
  decoded: string;
  unknown: number;
  confidence: number;
  dotMs: number | null;
}

function roundTrip(
  text: string,
  book: Codebook,
  opts: EncodeOptions,
  sampleRate = 8000,
  noiseAmp = 0,
  volume = 0.9,
  frequency = 600,
): RoundTrip {
  const enc = encodeText(text, book, opts);
  let samples = renderTimeline(enc.timeline, {
    sampleRate,
    frequency,
    volume,
  });
  if (noiseAmp > 0) samples = addNoise(samples, noiseAmp);
  const dec = decodeAudio(samples, sampleRate, book);
  return {
    text,
    morse: enc.morse,
    decoded: dec.text,
    unknown: dec.unknownCount,
    confidence: dec.confidence,
    dotMs: dec.detectedDotMs,
  };
}

// ────────────────────────────────────────────────────────────
section('1. 码表完整性');
for (const book of CODEBOOKS) {
  const issues = validateCodebook(book);
  const n = Object.keys(book.entries).length;
  check(
    `${book.displayName ?? book.name} (${book.id})`,
    issues.length === 0,
    issues.length ? issues[0] : `${n} 字符`,
  );
}

// ────────────────────────────────────────────────────────────
section('2. 基础往返（各码表）');
const samples: Record<string, string[]> = {
  en: ['SOS', 'HELLO WORLD', 'CQ CQ DE MORSE', 'THE QUICK BROWN FOX', '12345', 'PARIS'],
  'mixed-zh-en': [
    'SOS',
    '中国',
    '中A',
    'CQ中国',
    'HELLO 世界',
    'CQ DE 张三',
    'QRZ 上海',
    'BOTH 中英 MIXED',
  ],
  ru: ['СОС', 'ПРИВЕТ', 'МОРЕ'],
  'zh-CN': ['中国', '摩斯电码', '中华人民共和国'],
  'zh-TW': ['中國', '台北'],
  'ja-wabun': ['アイウエオ', 'ニホン', 'カイ'],
  de: ['SOS', 'GRÜSSE', 'ÄÖÜ'],
  fr: ['SOS', 'BONJOUR', 'ÉLÈVE'],
  es: ['SOS', 'BUENOS', 'MAÑANA'],
};

for (const book of CODEBOOKS) {
  const list = samples[book.id] ?? ['SOS'];
  for (const text of list) {
    const r = roundTrip(text, book, { wpm: 18, frequency: 600, volume: 0.9 });
    const ok = r.decoded.replace(/\s/g, '') === text.replace(/\s/g, '');
    check(
      `${book.id}: "${text}"`,
      ok,
      ok ? r.morse.slice(0, 40) : `解码为 "${r.decoded}"`,
    );
  }
}

// ────────────────────────────────────────────────────────────
section('3. WPM 扫描');
{
  const book = getCodebook('en')!;
  for (const wpm of [8, 12, 18, 25, 35, 45]) {
    const r = roundTrip('CQ CQ DE MORSE', book, { wpm, frequency: 600, volume: 0.9 });
    const est = estimateWpm(r.dotMs);
    // 绝对误差 <= 4 WPM 或 相对误差 <= 12%（高速率下 5ms 包络窗量化所致）
    const err = Math.abs((est ?? 0) - wpm);
    const relErr = err / wpm;
    check(
      `${wpm} WPM`,
      r.decoded.trim() === 'CQ CQ DE MORSE' && (err <= 4 || relErr <= 0.12),
      `实测 ${est} WPM`,
    );
  }
}

// ────────────────────────────────────────────────────────────
section('4. 音高扫描');
{
  const book = getCodebook('en')!;
  for (const f of [400, 600, 800, 1000, 1400]) {
    const r = roundTrip('CQ CQ DE MORSE', book, { wpm: 18, frequency: f, volume: 0.9 });
    check(`${f} Hz`, r.decoded.trim() === 'CQ CQ DE MORSE');
  }
}

// ────────────────────────────────────────────────────────────
section('5. 采样率扫描');
{
  const book = getCodebook('en')!;
  for (const sr of [8000, 11025, 16000, 22050, 44100]) {
    const r = roundTrip('CQ CQ DE MORSE', book, { wpm: 18, frequency: 600, volume: 0.9 }, sr);
    check(`${sr} Hz`, r.decoded.trim() === 'CQ CQ DE MORSE');
  }
}

// ────────────────────────────────────────────────────────────
section('6. 噪声鲁棒性');
{
  const book = getCodebook('en')!;
  for (const na of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65]) {
    const r = roundTrip(
      'CQ CQ DE MORSE',
      book,
      { wpm: 18, frequency: 600, volume: 0.9 },
      8000,
      na,
    );
    check(
      `噪声 ${(na * 100).toFixed(0)}%`,
      r.decoded.trim() === 'CQ CQ DE MORSE',
      r.decoded.trim() === 'CQ CQ DE MORSE' ? `置信度 ${(r.confidence * 100).toFixed(0)}%` : `解码为 "${r.decoded.slice(0, 30)}"`,
    );
  }
}

// ────────────────────────────────────────────────────────────
section('7. 音量鲁棒性');
{
  const book = getCodebook('en')!;
  for (const v of [0.9, 0.5, 0.25, 0.12, 0.06, 0.03, 0.01]) {
    const r = roundTrip(
      'CQ CQ DE MORSE',
      book,
      { wpm: 18, frequency: 600, volume: v },
    );
    check(`音量 ${v}`, r.decoded.trim() === 'CQ CQ DE MORSE');
  }
}

// ────────────────────────────────────────────────────────────
section('8. 波形兼容性');
{
  const book = getCodebook('en')!;
  for (const wave of ['sine', 'square', 'triangle'] as const) {
    const enc = encodeText('CQ CQ', book, { wpm: 18, frequency: 600, volume: 0.9 });
    const samples = renderTimeline(enc.timeline, {
      sampleRate: 8000,
      frequency: 600,
      volume: 0.9,
      waveform: wave,
    });
    const dec = decodeAudio(samples, 8000, book);
    check(`波形 ${wave}`, dec.text.trim() === 'CQ CQ', `解码为 "${dec.text.trim()}"`);
  }
}

if (!QUICK) {
  section('9. WAV 文件往返');
  {
    const book = getCodebook('en')!;
    const enc = encodeText('CQ CQ DE MORSE', book, {
      wpm: 18,
      frequency: 600,
      volume: 0.9,
    });
    const samples = renderTimeline(enc.timeline, {
      sampleRate: 8000,
      frequency: 600,
      volume: 0.9,
    });
    const wav = encodeWav(samples, 8000);
    const back = decodeWav(wav);
    const dec = decodeAudio(back.samples, back.sampleRate, book);
    check(
      'WAV 写入 -> 读回 -> 解码',
      dec.text.trim() === 'CQ CQ DE MORSE',
      `${(wav.byteLength / 1024).toFixed(1)} KB, ${back.durationMs.toFixed(0)} ms`,
    );
  }

  section('10. 组合极端场景');
  {
    const book = getCodebook('en')!;
    const combos: [number, number][] = [
      [0.25, 0.25],
      [0.35, 0.12],
      [0.45, 0.06],
    ];
    for (const [na, vol] of combos) {
      const r = roundTrip(
        'CQ CQ DE MORSE',
        book,
        { wpm: 18, frequency: 600, volume: vol },
        8000,
        na,
      );
      const ok = r.decoded.trim() === 'CQ CQ DE MORSE';
      check(
        `噪声 ${(na * 100).toFixed(0)}% + 音量 ${vol}`,
        ok,
        ok ? '' : `解码为 "${r.decoded.slice(0, 24)}"（超出实用范围属预期）`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────
if (codebookArg) {
  section(`11. 指定码表详情: ${codebookArg}`);
  const book = getCodebook(codebookArg);
  if (!book) {
    console.log(`  ${C.red}未找到码表: ${codebookArg}${C.reset}`);
  } else {
    const sample = Object.entries(book.entries).slice(0, 10);
    for (const [ch, code] of sample) {
      console.log(`  ${C.dim}${ch}${C.reset} → ${code}`);
    }
    console.log(`  ${C.dim}... 共 ${Object.keys(book.entries).length} 字符${C.reset}`);
  }
}

console.log(
  `\n${C.bold}结果: ${C.green}${pass} 通过${C.reset}` +
    (fail > 0 ? `, ${C.red}${fail} 失败${C.reset}` : `, ${C.dim}0 失败${C.reset}`),
);
process.exit(fail > 0 ? 1 : 0);
