import type { Codebook, EncodeOptions, TimedElement } from './types';
import { lookupEncode } from './codebook';
import { MORSE_DIGITS } from './codebooks/morse-digits';

/**
 * 标准摩斯时序单位定义（单位数）
 *  - 点: 1, 划: 3
 *  - 码内间隔 (intra-character gap): 1
 *  - 字符间隔 (inter-character gap): 3
 *  - 词间隔 (word gap): 7
 */
export const TIMING_UNITS = {
  dot: 1,
  dash: 3,
  intraGap: 1,
  charGap: 3,
  groupGap: 5,
  wordGap: 7,
} as const;

/**
 * 计算一个 dot 单位的时长（毫秒）
 *
 * PARIS 基准：dot=1单位, dash=3单位, 码内=1, 字符=3, 词=7，
 * 总计 50 单位对应 1 词间隔 1.2s（标准定义）
 * 因此 1 单位 = 1.2 / WPM * 1000 ms
 */
export function dotUnitMs(wpm: number): number {
  const w = Math.max(1, wpm);
  return (1.2 / w) * 1000;
}

/** 一个「信号单元」：一个可传输的摩斯符号 */
export interface SignalUnit {
  /** 摩斯点划串 */
  morse: string;
  /** 该单元之后的间隔类型（undefined = 无间隔） */
  sepAfter?: 'char' | 'group' | 'word';
}

/** 编码结果 */
export interface EncodeResult {
  /** 时序元素列表 */
  timeline: TimedElement[];
  /** 摩斯点划串，字符以 / 分隔，词以 | 分隔 */
  morse: string;
  /** 无法编码的字符列表 */
  unsupported: string[];
  /** 总时长（毫秒） */
  durationMs: number;
  /** 实际使用的 dot 时长 */
  dotMs: number;
  /** 信号单元序列（便于 UI 可视化） */
  units: SignalUnit[];
}

/**
 * 取码表使用的间隔方案。
 */
export function gapsOf(book: Codebook): { char: number; group: number; word: number } {
  const g = book.gaps;
  if (g) {
    return { char: g.char, group: g.group ?? g.char + 2, word: g.word };
  }
  return {
    char: TIMING_UNITS.charGap,
    group: TIMING_UNITS.groupGap,
    word: TIMING_UNITS.wordGap,
  };
}

/**
 * 将文本拆解为信号单元序列。
 *
 * morse 体系：每个字符 -> 一个摩斯符号
 * telegraph 体系：每个字符 -> 4 位数字 -> 4 个摩斯符号
 * mixed 体系：拉丁字母直接发点划，汉字发 4 位电码数字，两者混排
 */
export function buildUnits(
  text: string,
  book: Codebook,
): { units: SignalUnit[]; unsupported: string[] } {
  const units: SignalUnit[] = [];
  const unsupported: string[] = [];

  const words = text.split(/\s+/).filter((w) => w.length > 0);

  words.forEach((word, wi) => {
    const lastWord = wi === words.length - 1;

    if (book.system === 'telegraph' || book.system === 'mixed') {
      // ── 混合体系的单元构造 ──
      //
      // 先把每个字符展开成「码组」：
      //  - 汉字 -> 一个 4 位数字码组（如 "0022"）
      //  - 拉丁字母 -> 一个点划码组（如 ".-"）
      //
      // 两类码组靠**码组间隔（group gap, 5u）**区分：
      // 中文码组之后跟 group 间隔，拉丁码组之后跟 char 间隔（3u）。
      // 解码端据此知道「这一段是 4 位数字」还是「这一段是一个字母」。
      type Seg = { kind: 'digits' | 'morse'; code: string };

      const segs: Seg[] = [];
      for (const ch of word) {
        const code = lookupEncode(book, ch);
        if (code === null) {
          if (!unsupported.includes(ch)) unsupported.push(ch);
          continue;
        }
        // 码值是点划串 -> 拉丁；是数字串 -> 中文电码
        if (/^[.\-]+$/.test(code)) {
          segs.push({ kind: 'morse', code });
        } else {
          // 异体字可能有多组（如 "1057 7775"），拆成多个码组
          for (const digits of code.split(' ')) {
            segs.push({ kind: 'digits', code: digits });
          }
        }
      }

      // 为每个段确定其后的分隔级别。
      //
      // 规则（关键：靠间隔长度区分中文码组与拉丁字母）：
      //  - 数字码组内部（4 位之间）→ char (3u)
      //  - 数字码组结束之后        → group (5u)  ← 标记「这是一组电码数字」
      //  - 拉丁字母之后            → char (3u)
      //  - 词末尾                  → word (9u)
      //
      // 注意「数字码组结束之后」不论下一段是什么（字母、汉字、还是词末尾），
      // 都必须发 group —— 否则解码端无法把 4 个数字聚成一组。
      // 早期版本只在「不是最后一段」时发 group，导致 "CQ中" 里
      // 「中」的 4 位数字被拆成 4 个独立字母输出（CQ0022）。
      segs.forEach((seg, si) => {
        const isLastSeg = si === segs.length - 1;

        if (seg.kind === 'digits') {
          const digits = seg.code.split('');
          digits.forEach((d, di) => {
            const m = MORSE_DIGITS[d];
            if (!m) return;
            const isLastDigit = di === digits.length - 1;
            let sep: SignalUnit['sepAfter'];
            if (!isLastDigit) {
              // 组内数字之间用 char 间隔（3u）
              sep = 'char';
            } else if (!isLastSeg) {
              // 码组之后用 group 间隔（5u）
              sep = 'group';
            } else {
              // 该码组是本词最后一段：仍然要发 group，
              // 让解码端明确「这 4 位数字是一组」，词边界由 word 表达
              sep = lastWord ? 'group' : 'word';
            }
            units.push({ morse: m, sepAfter: sep });
          });
        } else {
          let sep: SignalUnit['sepAfter'];
          if (!isLastSeg) {
            // 字母之后：若下一段是中文码组，用 group 标记字母结束；
            // 否则用 char（字母之间）
            sep = segs[si + 1].kind === 'digits' ? 'group' : 'char';
          } else {
            sep = lastWord ? undefined : 'word';
          }
          units.push({ morse: seg.code, sepAfter: sep });
        }
      });
    } else {
      // 摩斯体系：每个字符 -> 一个摩斯符号
      const codes: string[] = [];
      for (const ch of word) {
        const code = lookupEncode(book, ch);
        if (code === null) {
          if (!unsupported.includes(ch)) unsupported.push(ch);
          continue;
        }
        codes.push(code);
      }

      codes.forEach((code, ci) => {
        let sep: SignalUnit['sepAfter'];
        if (ci < codes.length - 1) sep = 'char';
        else if (!lastWord) sep = 'word';
        units.push({ morse: code, sepAfter: sep });
      });
    }
  });

  return { units, unsupported };
}

/**
 * 将文本编码为摩斯时序。
 *
 * @param text 输入文本
 * @param book 码表
 * @param options 编码参数
 */
export function encodeText(
  text: string,
  book: Codebook,
  options: EncodeOptions,
): EncodeResult {
  const dotMs = dotUnitMs(options.wpm);
  const u = (n: number) => n * dotMs;
  const gaps = gapsOf(book);

  const { units, unsupported } = buildUnits(text, book);

  const timeline: TimedElement[] = [];

  units.forEach((unit) => {
    const marks = unit.morse.split('');
    marks.forEach((m, mi) => {
      if (m === '.') {
        timeline.push({ kind: 'dot', durationMs: u(TIMING_UNITS.dot) });
      } else if (m === '-') {
        timeline.push({ kind: 'dash', durationMs: u(TIMING_UNITS.dash) });
      }
      if (mi < marks.length - 1) {
        timeline.push({ kind: 'gap', durationMs: u(TIMING_UNITS.intraGap) });
      }
    });

    if (unit.sepAfter) {
      const g =
        unit.sepAfter === 'char'
          ? gaps.char
          : unit.sepAfter === 'group'
            ? gaps.group
            : gaps.word;
      timeline.push({ kind: 'gap', durationMs: u(g) });
    }
  });

  const durationMs = timeline.reduce((a, e) => a + e.durationMs, 0);

  // 摩斯串：字符以 / 分隔，词以 | 分隔
  // 按分隔级别重建词边界（group 级分隔不算词边界）
  const wordGroups: string[][] = [[]];
  units.forEach((unit, i) => {
    wordGroups[wordGroups.length - 1].push(unit.morse);
    const sep = unit.sepAfter;
    if (sep === 'word') {
      wordGroups.push([]);
    } else if (sep === 'group' && book.system === 'morse') {
      // 摩斯体系无 group 级
    }
  });
  const morse = wordGroups
    .filter((g) => g.length > 0)
    .map((g) => g.join('/'))
    .join('|');

  return {
    timeline,
    morse,
    unsupported,
    durationMs,
    dotMs,
    units,
  };
}

/**
 * 将摩斯点划串解析为字符（纯文本层面，不涉及音频）。
 * 支持 "/ 分隔字符，| 分隔词"。
 */
export function decodeMorseString(
  morse: string,
  book: Codebook,
): { text: string; unknown: number } {
  let unknown = 0;
  const words = morse
    .split('|')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  const text = words
    .map((word) => {
      const chars = word
        .split('/')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      return chars
        .map((c) => {
          const ch = book.reverse[c];
          if (ch === undefined) {
            unknown++;
            return '?';
          }
          return ch;
        })
        .join('');
    })
    .join(' ');

  return { text, unknown };
}

/**
 * 估算一段摩斯串所占时长（毫秒）
 */
export function estimateDurationMs(morse: string, wpm: number): number {
  const dotMs = dotUnitMs(wpm);
  const words = morse.split('|').filter((w) => w.trim().length > 0);
  let total = 0;
  words.forEach((word, wi) => {
    const chars = word.split('/').filter((c) => c.trim().length > 0);
    chars.forEach((code, ci) => {
      const marks = code.trim();
      for (let i = 0; i < marks.length; i++) {
        total += (marks[i] === '-' ? TIMING_UNITS.dash : TIMING_UNITS.dot) * dotMs;
        if (i < marks.length - 1) total += TIMING_UNITS.intraGap * dotMs;
      }
      if (ci < chars.length - 1) total += TIMING_UNITS.charGap * dotMs;
    });
    if (wi < words.length - 1) total += TIMING_UNITS.wordGap * dotMs;
  });
  return total;
}
