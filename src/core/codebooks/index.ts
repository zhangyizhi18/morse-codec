import type { Codebook, CodebookMeta } from '../types';
import { metaOf } from '../codebook';
import { MORSE_LATIN } from './morse-latin';
import { MORSE_CYRILLIC } from './morse-cyrillic';
import { MORSE_GERMAN } from './morse-german';
import { MORSE_FRENCH } from './morse-french';
import { MORSE_SPANISH } from './morse-spanish';
import { MORSE_WABUN } from './morse-wabun';
import { MORSE_MIXED } from './morse-mixed';
import { TELEGRAPH_CN } from './generated/telegraph-cn';
import { TELEGRAPH_TW } from './generated/telegraph-tw';

/**
 * 全部内置码表。
 *
 * 类型：
 *  - morse    : 字符 <-> 摩斯点划串（拉丁、西里尔、德/法/西、日语和文）
 *  - telegraph: 字符 <-> 数字码（中文电码），编码时数字按摩斯发出
 *  - mixed    : 中英混排，拉丁发点划、汉字发 4 位电码，靠 group 间隔区分
 *
 * 注意：德/法/西语拆成独立码表，因为它们的变音字母存在码字重叠，
 * 合并为一张表会导致解码歧义。
 */
export const CODEBOOKS: Codebook[] = [
  MORSE_LATIN,
  MORSE_MIXED,
  TELEGRAPH_CN,
  TELEGRAPH_TW,
  MORSE_CYRILLIC,
  MORSE_WABUN,
  MORSE_GERMAN,
  MORSE_FRENCH,
  MORSE_SPANISH,
];

const BY_ID = new Map(CODEBOOKS.map((b) => [b.id, b]));

/** 按 id 取码表 */
export function getCodebook(id: string): Codebook | undefined {
  return BY_ID.get(id);
}

/** 默认码表（国际摩斯） */
export function defaultCodebook(): Codebook {
  return MORSE_LATIN;
}

/** 所有码表的元信息（供 UI 下拉） */
export function listCodebooks(): CodebookMeta[] {
  return CODEBOOKS.map(metaOf);
}

export {
  MORSE_LATIN,
  MORSE_CYRILLIC,
  MORSE_GERMAN,
  MORSE_FRENCH,
  MORSE_SPANISH,
  MORSE_WABUN,
  MORSE_MIXED,
  TELEGRAPH_CN,
  TELEGRAPH_TW,
};
