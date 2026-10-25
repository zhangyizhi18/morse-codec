import type { Codebook, CodebookMeta } from './types';

/**
 * 构建码表：生成反向索引并做一致性校验。
 *
 * @param def 码表定义（不含 reverse）
 * @returns 完整码表
 */
export function buildCodebook(def: Omit<Codebook, 'reverse'>): Codebook {
  const reverse: Record<string, string> = {};
  for (const [ch, code] of Object.entries(def.entries)) {
    // 保留第一个出现的字符，避免覆盖（码表冲突时以先到者为准）
    if (!(code in reverse)) reverse[code] = ch;
  }
  return { ...def, reverse };
}

/**
 * 校验码表完整性。
 *
 * @returns 问题列表，空数组表示通过
 */
export function validateCodebook(book: Codebook): string[] {
  const issues: string[] = [];
  const codes = new Map<string, string>();

  for (const [ch, code] of Object.entries(book.entries)) {
    if (!ch) {
      issues.push('存在空字符键');
      continue;
    }
    if (!code) {
      issues.push(`字符 "${ch}" 的电码为空`);
      continue;
    }
    if (book.system === 'morse') {
      if (!/^[.\-]+$/.test(code)) {
        issues.push(`字符 "${ch}" 的摩斯码非法: "${code}"`);
      }
      if (code.length > 8) {
        issues.push(`字符 "${ch}" 的摩斯码过长: "${code}"`);
      }
    } else if (book.system === 'telegraph') {
      // 允许 N 位数字（N 为该码表的码长），或空格分隔的多码组
      // 中文电码 = 4 位；和文电码 = 2 位
      const lengths = book.codeLengths ?? [4];
      const single = new RegExp(`^\\d{${Math.min(...lengths)}}$`);
      const multi = new RegExp(
        `^\\d{${Math.min(...lengths)}}( \\d{${Math.min(...lengths)}})*$`,
      );
      if (!single.test(code) && !multi.test(code)) {
        issues.push(`字符 "${ch}" 的电码非法: "${code}"`);
      }
    } else if (book.system === 'mixed') {
      // 混合体系：每条要么是点划串（拉丁），要么是 N 位数字（中文电码）
      const lengths = book.codeLengths ?? [4];
      const isMorse = /^[.\-]+$/.test(code);
      const single = new RegExp(`^\\d{${Math.min(...lengths)}}$`);
      const multi = new RegExp(
        `^\\d{${Math.min(...lengths)}}( \\d{${Math.min(...lengths)}})*$`,
      );
      if (!isMorse && !single.test(code) && !multi.test(code)) {
        issues.push(`字符 "${ch}" 的混合码非法: "${code}"`);
      }
      if (isMorse && code.length > 8) {
        issues.push(`字符 "${ch}" 的摩斯码过长: "${code}"`);
      }
    }
    const prev = codes.get(code);
    if (prev !== undefined) {
      issues.push(`电码冲突: "${code}" 同时对应 "${prev}" 与 "${ch}"`);
    } else {
      codes.set(code, ch);
    }
  }

  const revCount = Object.keys(book.reverse).length;
  if (revCount !== Object.keys(book.entries).length && revCount < codes.size) {
    issues.push(`反向索引不完整: ${revCount} < ${Object.keys(book.entries).length}`);
  }
  return issues;
}

/** 取码表元信息（去掉大字段） */
export function metaOf(book: Codebook): CodebookMeta {
  const { entries: _e, reverse: _r, ...meta } = book;
  return meta;
}

/**
 * 字符 -> 电码。未收录字符返回 null。
 *
 * 大小写不敏感：若码表收录的是大写变音（如 "Ü"），则 "ü" 也能匹配。
 * 摩斯电码本身不携带大小写信息，故码表以大写形式为准。
 */
export function lookupEncode(book: Codebook, ch: string): string | null {
  const direct = book.entries[ch];
  if (direct !== undefined) return direct;

  const upper = ch.toUpperCase();
  if (upper !== ch) {
    const u = book.entries[upper];
    if (u !== undefined) return u;
  }
  const lower = ch.toLowerCase();
  if (lower !== ch) {
    const l = book.entries[lower];
    if (l !== undefined) return l;
  }
  return null;
}

/**
 * 电码 -> 字符。未收录返回 null。
 */
export function lookupDecode(book: Codebook, code: string): string | null {
  const v = book.reverse[code];
  return v === undefined ? null : v;
}

/**
 * 电码 -> 字符（保留输入的大小写）。
 *
 * 码表只收录小写变音时（如 "ä"），解码得到 "Ä" 也能正确还原。
 */
export function lookupDecodePreserveCase(
  book: Codebook,
  code: string,
  caseHint: string | null,
): string | null {
  const base = lookupDecode(book, code);
  if (base === null) return null;
  if (!caseHint) return base;

  // caseHint 是原始字符；若其小写形式在码表中，则按 hint 的大小写还原
  const lower = caseHint.toLowerCase();
  if (book.entries[lower] !== undefined) return caseHint;
  return base;
}

/** 码表收录的字符集合 */
export function supportedChars(book: Codebook): Set<string> {
  return new Set(Object.keys(book.entries));
}
