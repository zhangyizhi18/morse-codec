/**
 * 中英混合码表（mixed 体系）
 *
 * ## 设计动机
 *
 * 中文电码把每个汉字编成 4 位数字（如「中」= 0022），发报时要连发 4 个
 * 数字、每个数字 5 个符号，共 20 个符号；而英文单词直接发字母，
 * 通常几个符号就够。实际通联里中英混排非常常见（"CQ DE 张三"、
 * "QRZ 上海"），如果强制只用一种体系，就必须在两种模式间来回切换。
 *
 * ## 为什么可以无歧义混排
 *
 * 三条硬约束保证了两种码组不会混淆：
 *
 *  1. **码字格式不同**：拉丁字母的码值只含 `.` `-`；
 *     中文电码的码值只含 `0-9`。格式本身就区分了两类字符。
 *
 *  2. **码长不同**：拉丁字母最长 4 个符号（B/C/F/H/J/L/P/Q/V/X/Y/Z…），
 *     而数字恒为 5 个符号（0-9 都是 5 位）。
 *     因此「连续 5 个符号」必然是一个数字，不可能是字母。
 *
 *  3. **间隔长度不同**（最关键的显式标记）：
 *     中文码组之后跟 **group 间隔（5u）**，拉丁字母之后跟 **char 间隔（3u）**。
 *     解码端据此判断「这一组是 4 位电码数字」还是「这一个字母」。
 *
 * 有了第 3 条，即使某个数字码与某个字母码碰巧相同，也能正确区分。
 * 实测两张表零字符冲突、零码值冲突，但间隔标记仍是必要的冗余保险 ——
 * 它让解码器无需猜测，直接按结构解析。
 *
 * ## 例
 *
 *   输入 "中A"
 *     → 中 = 0022 → 数字 0,0,2,2，每位 5 符号，组内 char 间隔
 *     → 4 位之后发 group 间隔（5u）
 *     → A = ".-"，之后发 word 间隔
 *
 *   解码端看到 group 间隔就知道前面 4 个数字是一组，还原成「中」。
 */
import type { Codebook } from '../types';
import { buildCodebook } from '../codebook';
import { MORSE_LATIN } from './morse-latin';
import { TELEGRAPH_CN } from './generated/telegraph-cn';

/**
 * 合并拉丁与中文电码条目。
 *
 * 冲突处理：中文电码优先。理由是中文字符集更大、更不可替代，
 * 而拉丁字符若与中文重名（实测为 0 个），保留中文才不丢信息。
 * 实际两表零重叠，此分支仅为防御。
 */
function mergeEntries(): Record<string, string> {
  const merged: Record<string, string> = { ...MORSE_LATIN.entries };
  for (const [ch, code] of Object.entries(TELEGRAPH_CN.entries)) {
    merged[ch] = code;
  }
  return merged;
}

export const MORSE_MIXED: Codebook = buildCodebook({
  id: 'mixed-zh-en',
  name: 'Mixed Chinese/English',
  displayName: '中英混合',
  system: 'mixed',
  direction: 'bidirectional',
  version: '1.0.0',
  source:
    'Merged from ITU-R M.1677-1 (Latin) + Unicode Unihan kMainlandTelegraph (Chinese)',
  license: 'MIT',
  /**
   * 间隔方案。
   *
   * char  = 3u  → 拉丁字母之间、中文码组内数字之间
   * group = 5u  → 中文码组之后（标记「这是一组电码数字」）
   * word  = 9u  → 词之间
   *
   * word 取 9u 而非 7u：因为 group 已是 5u，若词间隔用 7u，
   * 与 group 只差 2u，在低速/噪声下容易误判成 group，
   * 导致词边界丢失。9u 与 group 拉开到 4u，判定余量充足。
   */
  gaps: { char: 3, group: 5, word: 9 },
  codeLengths: [4],
  entries: mergeEntries(),
});
