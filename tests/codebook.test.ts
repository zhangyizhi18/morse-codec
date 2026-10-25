import { describe, it, expect } from 'vitest';
import {
  CODEBOOKS,
  getCodebook,
  validateCodebook,
  buildCodebook,
  lookupEncode,
  lookupDecode,
} from '../src/core';

describe('码表', () => {
  it('所有内置码表通过校验', () => {
    for (const book of CODEBOOKS) {
      const issues = validateCodebook(book);
      expect(issues, `${book.id}: ${issues.join('; ')}`).toEqual([]);
    }
  });

  it('码表 id 唯一', () => {
    const ids = CODEBOOKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('中文电码收录 7000+ 汉字', () => {
    const cn = getCodebook('zh-CN');
    expect(cn).toBeDefined();
    expect(Object.keys(cn!.entries).length).toBeGreaterThan(7000);
  });

  it('台湾电码收录 9000+ 汉字', () => {
    const tw = getCodebook('zh-TW');
    expect(tw).toBeDefined();
    expect(Object.keys(tw!.entries).length).toBeGreaterThan(9000);
  });

  it('中文电码「中」= 0022', () => {
    const cn = getCodebook('zh-CN')!;
    expect(cn.entries['中']).toBe('0022');
  });

  it('反向索引可用', () => {
    const cn = getCodebook('zh-CN')!;
    expect(lookupDecode(cn, '0022')).toBe('中');
  });

  it('小写字母自动转大写', () => {
    const en = getCodebook('en')!;
    expect(lookupEncode(en, 'a')).toBe('.-');
    expect(lookupEncode(en, 'A')).toBe('.-');
  });

  it('未收录字符返回 null', () => {
    const en = getCodebook('en')!;
    expect(lookupEncode(en, '中')).toBeNull();
  });

  it('buildCodebook 生成反向索引', () => {
    const b = buildCodebook({
      id: 'x',
      name: 'x',
      system: 'morse',
      direction: 'bidirectional',
      version: '1',
      entries: { A: '.-', B: '-...' },
    });
    expect(b.reverse['.-']).toBe('A');
    expect(b.reverse['-...']).toBe('B');
  });

  it('俄语码表含西里尔字母', () => {
    const ru = getCodebook('ru')!;
    expect(ru.entries['А']).toBe('.-');
    expect(ru.entries['Я']).toBe('.-.-');
  });

  it('和文电码含假名', () => {
    const ja = getCodebook('ja-wabun')!;
    // 和文码表使用片假名
    expect(ja.entries['ア']).toBe('--.--');
    expect(ja.entries['イ']).toBe('.-');
    expect(ja.entries['ン']).toBe('.-.-.');
    expect(ja.entries['゛']).toBe('..');
  });
});
