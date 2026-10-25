import type {
  Codebook,
  DecodeOptions,
  DecodeResult,
  RunSegment,
  SeparatorLevel,
} from './types';
import { gapsOf, TIMING_UNITS } from './encoder';
import { MORSE_DIGITS } from './codebooks/morse-digits';

/**
 * 摩斯解码器：音频采样 -> 文本
 *
 * 流水线：
 *  1. RMS 包络提取（可配置窗口，默认 5ms）
 *  2. 中值滤波（去除脉冲尖峰，默认半径 2）
 *  3. Otsu 双峰阈值分割（自适应，抵抗噪声与音量变化）
 *  4. ON/OFF 游程提取  ← 必须同时保留 OFF 段，否则无法区分间隔类型
 *  5. 点划判定（短=点，长=划）→ 码字 → 分隔级别 → 查表 → 文本
 *
 * 相对 dot 时长的判定阈值：
 *  - 划:       >= 2.0 * dot
 *  - 字符间隔: >= 2.5 * dot   (3 单位)
 *  - 码组间隔: >= 3.5 * dot   (5 单位，仅 telegraph)
 *  - 词间隔:   >= 5.0 * dot   (7 单位)
 */

const DEFAULT_WINDOW_MS = 5;
const DEFAULT_MEDIAN_RADIUS = 2;

/** 中值滤波 */
export function medianFilter(data: number[], radius: number): number[] {
  if (radius <= 0 || data.length === 0) return data.slice();
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(data.length - 1, i + radius);
    const window: number[] = [];
    for (let j = lo; j <= hi; j++) window.push(data[j]);
    window.sort((a, b) => a - b);
    out[i] = window[window.length >> 1];
  }
  return out;
}

/**
 * Otsu 阈值：把一维直方图分成前景/背景两类，使类间方差最大化。
 * 适用于「有信号 / 无信号」双峰分布——正是摩斯音频包络的特征。
 */
export function otsuThreshold(values: number[]): number {
  if (values.length === 0) return 0;
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return 0;

  const BINS = 64;
  const hist = new Array<number>(BINS).fill(0);
  for (const v of values) {
    let b = Math.floor((v / max) * BINS);
    if (b < 0) b = 0;
    if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }

  const N = values.length;
  let totalSum = 0;
  for (let i = 0; i < BINS; i++) totalSum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;

  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = N - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (totalSum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }

  return ((best + 0.5) / BINS) * max;
}

/**
 * 提取 RMS 包络。
 */
export function computeEnvelope(
  samples: Float32Array,
  sampleRate: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): number[] {
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const env: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(i + win, samples.length);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      sum += v * v;
    }
    env.push(Math.sqrt(sum / (end - i)));
  }
  return env;
}

/**
 * 游程提取：把包络按阈值切成 ON/OFF 段。
 *
 * 关键：必须同时保留 ON 与 OFF 段。缺少 OFF 段将无法区分
 * 「码内间隔(1单位)」「字符间隔(3单位)」「词间隔(7单位)」。
 */
export function extractRuns(env: number[], threshold: number): RunSegment[] {
  const runs: RunSegment[] = [];
  if (env.length === 0) return runs;

  let start = 0;
  let curOn = env[0] > threshold;

  for (let i = 1; i <= env.length; i++) {
    const on = i < env.length && env[i] > threshold;
    if (on !== curOn) {
      runs.push({ on: curOn, length: i - start });
      start = i;
      curOn = on;
    }
  }
  return runs;
}

/**
 * 游程边界的亚帧精度修正。
 *
 * 包络按窗口（如 5ms）离散化，信号边界的量化误差在高速率下可达 ±6%。
 * 这里用线性插值把每个跳变点定位到亚帧精度：
 * 阈值 crossing 位于 prev 与 cur 两帧之间，按比例插值求零点。
 */
export function refineRuns(env: number[], threshold: number): RunSegment[] {
  const raw = extractRuns(env, threshold);
  if (raw.length < 2 || env.length < 2) return raw;

  const out: RunSegment[] = [];

  // raw[i] 的起始帧索引
  const starts: number[] = [];
  let acc = 0;
  for (const r of raw) {
    starts.push(acc);
    acc += r.length;
  }

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    const startIdx = starts[i];
    const endIdx = startIdx + seg.length; // 该段结束帧（不含）
    let end = endIdx;

    // 在 endIdx-1 与 endIdx 之间插值求阈值零点
    if (i < raw.length - 1 && endIdx >= 1 && endIdx < env.length) {
      const a = env[endIdx - 1] - threshold;
      const b = env[endIdx] - threshold;
      if (a !== b) {
        const frac = a / (a - b);
        end = endIdx - 1 + Math.min(1, Math.max(0, frac));
      }
    }

    out.push({ on: seg.on, length: end - startIdx });
  }

  return out;
}

/**
 * 从 ON 段长度联合估计 dot 时长。
 *
 * 摩斯信号中点=1单位、划=3单位。只取「最短 ON 段」会受量化误差影响，
 * 这里用全部 ON 段做稳健估计：
 *  1. 先用最短段给出初始估计
 *  2. 把每个 ON 段按「1 单位还是 3 单位」归类
 *  3. 取所有 len/k 的中位数作为最终估计
 */
export function estimateDotFrames(onLengths: number[]): number {
  if (onLengths.length === 0) return 0;
  const sorted = [...onLengths].sort((a, b) => a - b);
  let dot = sorted[0];

  // 两轮迭代，收敛到稳定的联合估计
  for (let iter = 0; iter < 2; iter++) {
    if (dot <= 0) return sorted[0];
    const candidates: number[] = [];
    for (const len of onLengths) {
      // 阈值 2 单位：短于 2 单位视为点，否则视为划
      const k = len < dot * 2 ? 1 : 3;
      candidates.push(len / k);
    }
    candidates.sort((a, b) => a - b);
    const median = candidates[candidates.length >> 1];
    if (median > 0) dot = median;
  }
  return dot;
}

/** 一个解析出的符号及其后分隔级别 */
export interface ParsedSymbol {
  /** 摩斯点划串 */
  morse: string;
  /** 与后一个符号之间的分隔级别 */
  sepAfter: SeparatorLevel | null;
}

/** 游程解析结果 */
export interface ParsedMorse {
  /** 符号序列 */
  symbols: ParsedSymbol[];
  /** 检测到的 dot 时长（ms） */
  dotMs: number;
}

/**
 * 从游程解析摩斯符号与分隔级别。
 *
 * @param runs 游程
 * @param frameMs 每帧时长（ms）
 * @param book 码表（决定间隔方案）
 */
export function parseRuns(
  runs: RunSegment[],
  frameMs: number,
  book: Codebook,
): ParsedMorse {
  const firstOn = runs.findIndex((r) => r.on);
  if (firstOn < 0) return { symbols: [], dotMs: 0 };

  const sig = runs.slice(firstOn);

  // dot 长度 = 最短的 ON 段
  const onLengths = sig
    .filter((r) => r.on)
    .map((r) => r.length)
    .filter((l) => l > 0);
  if (onLengths.length === 0) return { symbols: [], dotMs: 0 };

  // dot 长度：联合估计（点/划都参与），比「取最短段」更抗量化误差
  const dotFrames = estimateDotFrames(onLengths);
  if (dotFrames <= 0) return { symbols: [], dotMs: 0 };
  const dotMs = dotFrames * frameMs;

  const gaps = gapsOf(book);

  // 判定阈值（相对 dot）。
  //
  // 必须按码表的实际间隔方案推导，不能写死 ——
  // 混合码表的 group=5u、word=9u，若仍用「word=5u」的固定阈值，
  // 5u 的码组间隔会被误判成词间隔，中文之间凭空多出空格。
  //
  // 取相邻两级的中点作为分界，两侧余量相等：
  //   码内 1u | 字符 3u | 码组 5u | 词 9u
  const dashThresh = dotFrames * 2.0;
  const charThresh = dotFrames * ((TIMING_UNITS.intraGap + gaps.char) / 2);
  const groupThresh = dotFrames * ((gaps.char + gaps.group) / 2);
  const wordThresh = dotFrames * ((gaps.group + gaps.word) / 2);

  const symbols: ParsedSymbol[] = [];
  let cur = '';

  for (let i = 0; i < sig.length; i++) {
    const r = sig[i];
    if (!r.on) continue;

    cur += r.length < dashThresh ? '.' : '-';

    const next = sig[i + 1];
    if (!next) {
      // 末尾信号
      if (cur.length > 0) symbols.push({ morse: cur, sepAfter: null });
      cur = '';
      break;
    }
    if (next.on) continue; // 紧邻的 ON，中间没有 OFF（异常），继续累积

    const gapLen = next.length;
    if (gapLen >= wordThresh) {
      symbols.push({ morse: cur, sepAfter: 'word' });
      cur = '';
    } else if (gapLen >= groupThresh) {
      symbols.push({ morse: cur, sepAfter: 'group' });
      cur = '';
    } else if (gapLen >= charThresh) {
      symbols.push({ morse: cur, sepAfter: 'char' });
      cur = '';
    }
    // 否则是码内间隔（< charThresh），继续累积当前符号
  }
  if (cur.length > 0) symbols.push({ morse: cur, sepAfter: null });

  return { symbols, dotMs };
}

/**
 * 将符号序列转文本。
 *
 * morse 体系：符号 -> 字符
 * telegraph 体系：符号 -> 数字，每 4 位组成一个码组 -> 汉字
 * mixed 体系：按 group 间隔切分码组，再逐组判定是「中文电码」还是「拉丁字母」
 */
export function symbolsToText(
  symbols: ParsedSymbol[],
  book: Codebook,
): { text: string; morse: string; unknown: number } {
  let unknown = 0;
  const morseParts: string[] = [];

  if (book.system === 'mixed') {
    return mixedSymbolsToText(symbols, book);
  }

  if (book.system === 'telegraph') {
    // 符号 -> 数字：用「数字的摩斯码」表反查
    const digitOf: Record<string, string> = {};
    for (const [d, m] of Object.entries(MORSE_DIGITS)) digitOf[m] = d;

    // 收集「组」：以 group/word 分隔的符号构成一组数字
    const groups: { digits: string; sep: SeparatorLevel | null }[] = [];
    let digits = '';
    let pendingSep: SeparatorLevel | null = null;

    const flush = () => {
      if (digits.length > 0) {
        groups.push({ digits, sep: pendingSep });
        digits = '';
        pendingSep = null;
      }
    };

    for (const s of symbols) {
      const d = digitOf[s.morse];
      morseParts.push(s.morse);
      if (d === undefined) {
        // 无法识别的符号
        unknown++;
        if (digits.length > 0) {
          groups.push({ digits, sep: 'char' });
          digits = '';
        }
        pendingSep = s.sepAfter;
        continue;
      }
      digits += d;
      if (s.sepAfter === 'group' || s.sepAfter === 'word') {
        flush();
        pendingSep = s.sepAfter;
      }
    }
    flush();

    const outParts: string[] = [];
    // 支持多码组字符（异体字，如 "1057 7775" -> 塵）
    let pendingGroups: string[] = [];

    const flushGroups = () => {
      if (pendingGroups.length === 0) return;
      const combined = pendingGroups.join(' ');
      const ch = book.reverse[combined];
      if (ch === undefined) {
        // 尝试单组直查
        if (pendingGroups.length === 1) {
          const single = book.reverse[pendingGroups[0]];
          if (single !== undefined) {
            outParts.push(single);
            pendingGroups = [];
            return;
          }
        }
        unknown++;
        outParts.push('?');
      } else {
        outParts.push(ch);
      }
      pendingGroups = [];
    };

    for (const g of groups) {
      if (g.digits.length === 4) {
        // 尝试直接命中单字符
        const direct = book.reverse[g.digits];
        if (direct !== undefined) {
          flushGroups();
          outParts.push(direct);
        } else {
          // 可能是多码组字符的前半部分，先暂存
          pendingGroups.push(g.digits);
        }
      } else {
        // 位数不足，可能是开头/结尾截断
        if (g.digits.length > 0) unknown++;
        flushGroups();
      }
      if (g.sep === 'word') {
        flushGroups();
        outParts.push(' ');
      }
    }
    flushGroups();
    const text = outParts
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    return { text, morse: morseParts.join('/'), unknown };
  }

  // morse 体系
  const words: string[][] = [];
  let current: string[] = [];

  for (const s of symbols) {
    const ch = book.reverse[s.morse];
    if (ch === undefined) {
      unknown++;
      current.push('?');
    } else {
      // 摩斯电码不携带大小写信息，统一按码表中的规范形式输出。
      // 码表以大写为规范时输出大写，否则保持原样。
      current.push(ch);
    }
    morseParts.push(s.morse);
    if (s.sepAfter === 'word') {
      words.push(current);
      current = [];
    }
  }
  if (current.length > 0) words.push(current);

  const text = words.map((w) => w.join('')).join(' ');
  return { text, morse: morseParts.join('/'), unknown };
}

/**
 * 混合体系的符号 -> 文本。
 *
 * ## 解析策略
 *
 * 1. 先按 **group 间隔（5u）** 把符号流切成「码组」。
 *    每个码组内部的符号之间是 char 间隔（3u）。
 *
 * 2. 逐个码组判定类型：
 *    - 码组内所有符号都是「数字的摩斯码」（5 个符号一组）→ 中文电码，
 *      把 4 位数字拼起来查表得到汉字。
 *    - 否则 → 拉丁字母，直接用点划串查表。
 *
 * 3. word 间隔在输出中补空格。
 *
 * ## 为什么这样能区分
 *
 * 编码端保证：中文码组之后发 group 间隔，拉丁字母之后发 char 间隔。
 * 因此「一个码组」要么整组是 4 个数字（20 个符号），
 * 要么是一个字母（1~4 个符号），不会混淆。
 */
function mixedSymbolsToText(
  symbols: ParsedSymbol[],
  book: Codebook,
): { text: string; morse: string; unknown: number } {
  let unknown = 0;
  const morseParts: string[] = [];
  const out: string[] = [];

  // 数字摩斯码 -> 数字
  const digitOf: Record<string, string> = {};
  for (const [d, m] of Object.entries(MORSE_DIGITS)) digitOf[m] = d;

  const groupLen = book.codeLengths?.[0] ?? 4;

  /** 把一个码组解析成文本 */
  const flushGroup = (group: ParsedSymbol[]) => {
    if (group.length === 0) return;

    // 整组都是「数字的摩斯码」且位数正好 → 中文电码
    const digits = group.map((s) => digitOf[s.morse]);
    const allDigits = digits.every((d) => d !== undefined);

    if (allDigits && group.length === groupLen) {
      const code = digits.join('');
      const ch = book.reverse[code];
      if (ch !== undefined) {
        out.push(ch);
        return;
      }
      // 该 4 位码不在中文表里 → 说明用户其实发的是 4 个数字，
      // 按拉丁逐字符还原（如 "5555" 解成 "5555" 而非乱码）。
    }

    // 拉丁字母：每个符号就是一个字符，逐个还原
    for (const s of group) {
      const ch = book.reverse[s.morse];
      if (ch === undefined) {
        unknown++;
        out.push('?');
      } else {
        out.push(ch);
      }
    }
  };

  let group: ParsedSymbol[] = [];

  for (const s of symbols) {
    morseParts.push(s.morse);

    // 关键：group 间隔既可能是「中文码组结束」，也可能是「字母结束后
    // 紧接中文码组」。因此先判断当前累积的组里是否已有非数字符号 ——
    // 若有，说明这是字母（可能多个），逐个输出；否则整组按中文码解析。
    group.push(s);

    if (s.sepAfter === 'group' || s.sepAfter === 'word') {
      flushGroup(group);
      group = [];
      if (s.sepAfter === 'word') out.push(' ');
    }
    // char 间隔：继续累积（可能是组内数字之间，也可能是字母之间）
  }
  flushGroup(group);

  const text = out.join('').replace(/\s+/g, ' ').trim();
  return { text, morse: morseParts.join('/'), unknown };
}

/**
 * 计算置信度（0~1）。
 */
export function computeConfidence(
  unknown: number,
  total: number,
  runs: RunSegment[],
  dotFrames: number,
): number {
  if (total === 0) return 0;

  const unknownPenalty = Math.min(1, unknown / total);
  const onLengths = runs
    .filter((r) => r.on)
    .map((r) => r.length)
    .filter((l) => l > 0);

  let consistency = 1;
  if (onLengths.length > 1 && dotFrames > 0) {
    let errSum = 0;
    for (const l of onLengths) {
      const ratio = l / dotFrames;
      const dist = Math.min(Math.abs(ratio - 1), Math.abs(ratio - 3));
      errSum += dist;
    }
    const meanErr = errSum / onLengths.length;
    consistency = Math.max(0, 1 - meanErr / 1.5);
  }

  return Math.max(0, Math.min(1, (1 - unknownPenalty) * consistency));
}

/**
 * 精确测量 dot 时长（毫秒）。
 *
 * 策略：
 *  1. 用粗包络（默认 5ms 窗）定位信号区域，得到 ON 段的大致位置
 *  2. 在每个 ON 段边界附近，用细窗（1ms）重新定位跳变点，
 *     消除 5ms 窗带来的 ±6% 量化误差
 *  3. 用精化后的 ON 段长度做点/划联合估计
 *
 * @param samples 原始采样
 * @param sampleRate 采样率
 * @param roughRuns 粗粒度游程（基于粗包络）
 * @param roughWindowMs 粗包络窗口
 */
export function measurePreciseDotMs(
  samples: Float32Array,
  sampleRate: number,
  roughRuns: RunSegment[],
  roughWindowMs: number,
): number {
  if (samples.length === 0 || roughRuns.length === 0) return 0;

  // 收集所有 ON 段的起止采样位置
  const onBounds: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const r of roughRuns) {
    const startSample = Math.round(cursor * roughWindowMs * (sampleRate / 1000));
    const endSample = Math.round(
      (cursor + r.length) * roughWindowMs * (sampleRate / 1000),
    );
    if (r.on && endSample > startSample) {
      onBounds.push({ start: startSample, end: endSample });
    }
    cursor += r.length;
  }
  if (onBounds.length === 0) return 0;

  // 细粒度测量：直接在原始采样上用局部阈值求边界
  const fineWindow = Math.max(1, Math.round(sampleRate * 0.001)); // 1ms
  const lengths: number[] = [];

  for (const b of onBounds) {
    // 在该段前后各扩 3ms 搜索边界
    const pad = Math.round(sampleRate * 0.003);
    const s0 = Math.max(0, b.start - pad);
    const s1 = Math.min(samples.length, b.end + pad);

    // 局部阈值：该段的 30% 峰值
    let peak = 0;
    for (let i = b.start; i < b.end && i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak <= 0) continue;
    const localThr = peak * 0.5;

    // 从段起点向前搜索上升沿
    let startIdx = b.start;
    for (let i = b.start; i > s0; i--) {
      if (Math.abs(samples[i]) < localThr) {
        startIdx = i;
        break;
      }
      startIdx = i;
    }
    // 从段终点向后搜索下降沿
    let endIdx = b.end;
    for (let i = b.end; i < s1; i++) {
      if (Math.abs(samples[i]) < localThr) {
        endIdx = i;
        break;
      }
      endIdx = i;
    }

    const lenMs = ((endIdx - startIdx) / sampleRate) * 1000;
    if (lenMs > 0) lengths.push(lenMs);
  }

  if (lengths.length === 0) return 0;

  // 点/划联合估计（len/k 的中位数）
  const sorted = [...lengths].sort((a, b) => a - b);
  let dot = sorted[0];
  for (let iter = 0; iter < 2; iter++) {
    if (dot <= 0) break;
    const cands = lengths.map((l) => (l < dot * 2 ? l : l / 3));
    cands.sort((a, b) => a - b);
    dot = cands[cands.length >> 1];
  }
  return dot;
}

/**
 * 解码音频采样为文本。
 */
export function decodeAudio(
  samples: Float32Array,
  sampleRate: number,
  book: Codebook,
  options: DecodeOptions = {},
): DecodeResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const medianRadius = options.medianRadius ?? DEFAULT_MEDIAN_RADIUS;

  const raw = computeEnvelope(samples, sampleRate, windowMs);
  const env = medianFilter(raw, medianRadius);

  let threshold: number;
  if (options.thresholdMode === 'fixed') {
    threshold = options.threshold ?? 0.15;
  } else {
    threshold = otsuThreshold(env);
  }

  const runs = refineRuns(env, threshold);
  const parsed = parseRuns(runs, windowMs, book);
  const { text, morse, unknown } = symbolsToText(parsed.symbols, book);

  // 用原始采样精化 dot 时长（消除包络窗口的量化误差）
  let detectedDotMs = parsed.dotMs;
  if (samples.length > 0) {
    const precise = measurePreciseDotMs(
      samples,
      sampleRate,
      runs,
      windowMs,
    );
    if (precise > 0) detectedDotMs = precise;
  }

  const confidence = computeConfidence(
    unknown,
    parsed.symbols.length,
    runs,
    detectedDotMs / windowMs,
  );

  return {
    text,
    morse,
    charCount: text.replace(/\s/g, '').length,
    confidence,
    detectedDotMs: detectedDotMs > 0 ? detectedDotMs : null,
    threshold,
    unknownCount: unknown,
    runs,
  };
}

/**
 * 从解码结果反推 WPM（字/分钟）。
 */
export function estimateWpm(dotMs: number | null): number | null {
  if (!dotMs || dotMs <= 0) return null;
  return Math.round((1.2 / (dotMs / 1000)) * 10) / 10;
}
