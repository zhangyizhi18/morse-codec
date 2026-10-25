import { describe, it, expect } from 'vitest';
import {
  encodeText,
  decodeMorseString,
  estimateDurationMs,
  dotUnitMs,
  getCodebook,
  buildUnits,
  TIMING_UNITS,
} from '../src/core';

const en = getCodebook('en')!;
const cn = getCodebook('zh-CN')!;

const opts = { wpm: 18, frequency: 600, volume: 0.9 };

describe('编码器', () => {
  it('dot 单位时长符合 PARIS 基准', () => {
    // PARIS: 50 单位 = 1.2s
    expect(dotUnitMs(20)).toBeCloseTo(60, 5);
    expect(dotUnitMs(10)).toBeCloseTo(120, 5);
  });

  it('编码 "SOS" 得到正确摩斯串', () => {
    const r = encodeText('SOS', en, opts);
    expect(r.morse).toBe('.../---/...');
  });

  it('编码含空格产生词分隔', () => {
    const r = encodeText('HI YOU', en, opts);
    // H=.... I=.. | Y=-.-- O=--- U=..-
    expect(r.morse).toBe('..../..|-.--/---/..-');
  });

  it('时序中 dot=1, dash=3 单位', () => {
    const r = encodeText('E', en, opts);
    const dots = r.timeline.filter((e) => e.kind === 'dot');
    const dashes = r.timeline.filter((e) => e.kind === 'dash');
    expect(dots[0].durationMs).toBeCloseTo(dotUnitMs(18), 3);
    expect(dashes.length).toBe(0);

    const r2 = encodeText('T', en, opts);
    const d = r2.timeline.filter((e) => e.kind === 'dash');
    expect(d[0].durationMs).toBeCloseTo(dotUnitMs(18) * 3, 3);
  });

  it('码内间隔 1 单位、字符间隔 3 单位、词间隔 7 单位', () => {
    const r = encodeText('EE', en, opts);
    const gaps = r.timeline.filter((e) => e.kind === 'gap');
    expect(gaps.length).toBe(1);
    expect(gaps[0].durationMs).toBeCloseTo(dotUnitMs(18) * 3, 3);

    const r2 = encodeText('E E', en, opts);
    const gaps2 = r2.timeline.filter((e) => e.kind === 'gap');
    expect(gaps2[gaps2.length - 1].durationMs).toBeCloseTo(dotUnitMs(18) * 7, 3);
  });

  it('总时长与估算函数一致', () => {
    const r = encodeText('CQ CQ DE MORSE', en, opts);
    const est = estimateDurationMs(r.morse, opts.wpm);
    expect(Math.abs(r.durationMs - est)).toBeLessThan(5);
  });

  it('未收录字符被报告', () => {
    const r = encodeText('A中B', en, opts);
    expect(r.unsupported).toContain('中');
  });

  it('解码摩斯串还原文本', () => {
    const r = encodeText('HELLO WORLD', en, opts);
    const d = decodeMorseString(r.morse, en);
    expect(d.text).toBe('HELLO WORLD');
    expect(d.unknown).toBe(0);
  });

  it('中文电码拆成单个数字摩斯符号', () => {
    const r = encodeText('中', cn, opts);
    // 0022 -> 0,0,2,2 四个数字摩斯符号
    expect(r.units.length).toBe(4);
    expect(r.units.map((u) => u.morse)).toEqual([
      '-----',
      '-----',
      '..---',
      '..---',
    ]);
  });

  it('中文电码单元间隔递增', () => {
    const r = encodeText('中国', cn, opts);
    // 中国 = 0022 + 0948
    const seps = r.units.map((u) => u.sepAfter);
    expect(seps[0]).toBe('char');
    expect(seps[1]).toBe('char');
    expect(seps[2]).toBe('char');
    expect(seps[3]).toBe('group');
  });

  it('buildUnits 处理空白与不支持字符', () => {
    const { units, unsupported } = buildUnits('中 A', cn);
    expect(units.length).toBe(4); // 「中」= 0022 -> 4 位
    expect(unsupported).toContain('A'); // 中文电码表不含拉丁字母
  });

  it('空输入返回空结果', () => {
    const r = encodeText('', en, opts);
    expect(r.timeline.length).toBe(0);
    expect(r.durationMs).toBe(0);
  });

  it('TIMING_UNITS 常量正确', () => {
    expect(TIMING_UNITS.dot).toBe(1);
    expect(TIMING_UNITS.dash).toBe(3);
    expect(TIMING_UNITS.charGap).toBe(3);
    expect(TIMING_UNITS.wordGap).toBe(7);
  });
});
