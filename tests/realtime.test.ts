import { describe, it, expect } from 'vitest';
import {
  RealtimeDecoder,
  getCodebook,
  encodeText,
  type Codebook,
} from '../src/core';

const en = getCodebook('en')!;

/**
 * 模拟真人打键：把编码后的时序按 10ms 步长喂给实时解码器。
 * 电平 = 有信号时 0.8，无信号时 0.02（带少量噪声）。
 */
function simulateKeying(
  text: string,
  book: Codebook,
  wpm = 18,
  opts: { noise?: number; speed?: number } = {},
) {
  const enc = encodeText(text, book, {
    wpm,
    frequency: 600,
    volume: 0.9,
  });
  const dec = new RealtimeDecoder(book);
  const STEP = 10; // ms
  const speed = opts.speed ?? 1;
  const noise = opts.noise ?? 0;

  let t = 0;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };

  // 把时序展开成「每步是否在信号」
  const steps: boolean[] = [];
  for (const el of enc.timeline) {
    const n = Math.max(1, Math.round((el.durationMs * speed) / STEP));
    const on = el.kind !== 'gap';
    for (let i = 0; i < n; i++) steps.push(on);
  }

  let last;
  for (const on of steps) {
    const level = on ? 0.8 : 0.02;
    const noisy = Math.max(0, level + rand() * noise);
    last = dec.push(noisy, t);
    t += STEP;
  }
  // 冲刷
  last = dec.flush(t + 500);

  return { state: last, expected: text };
}

describe('实时解码器', () => {
  it('解码 SOS', () => {
    const { state } = simulateKeying('SOS', en);
    expect(state.text.replace(/\s/g, '')).toBe('SOS');
  });

  it('解码多词文本', () => {
    const { state } = simulateKeying('HELLO WORLD', en);
    expect(state.text.replace(/\s+/g, ' ').trim()).toBe('HELLO WORLD');
  });

  it('解码 CQ CQ DE MORSE', () => {
    const { state } = simulateKeying('CQ CQ DE MORSE', en);
    expect(state.text.replace(/\s+/g, ' ').trim()).toBe('CQ CQ DE MORSE');
  });

  it('解码数字', () => {
    const { state } = simulateKeying('12345', en);
    expect(state.text.replace(/\s/g, '')).toBe('12345');
  });

  it('估计的 dot 时长接近真实值', () => {
    const { state } = simulateKeying('CQ CQ DE MORSE', en, 18);
    // 18 WPM -> dot = 66.7ms
    expect(state.unitMs).toBeGreaterThan(50);
    expect(state.unitMs).toBeLessThan(85);
  });

  it('不同速度都能解码', () => {
    for (const wpm of [10, 18, 30]) {
      const { state } = simulateKeying('SOS', en, wpm);
      expect(state.text.replace(/\s/g, ''), `wpm=${wpm}`).toBe('SOS');
    }
  });

  it('带噪声仍能解码', () => {
    const { state } = simulateKeying('CQ CQ', en, 18, { noise: 0.05 });
    expect(state.text.replace(/\s+/g, ' ').trim()).toBe('CQ CQ');
  });

  it('锁定状态与置信度正常', () => {
    const { state } = simulateKeying('PARIS', en);
    expect(state.locked).toBe(true);
    expect(state.confidence).toBeGreaterThan(0.5);
    expect(state.symbolCount).toBeGreaterThan(0);
  });

  it('reset 清空状态', () => {
    const dec = new RealtimeDecoder(en);
    dec.push(0.8, 0);
    dec.push(0.02, 100);
    dec.reset();
    const s = dec.getState();
    expect(s.text).toBe('');
    expect(s.symbolCount).toBe(0);
  });

  it('纯静音不产生输出', () => {
    const dec = new RealtimeDecoder(en);
    for (let t = 0; t < 2000; t += 10) dec.push(0.01, t);
    expect(dec.getState().text).toBe('');
  });

  it('中文电码实时解码', () => {
    const cn = getCodebook('zh-CN')!;
    const { state } = simulateKeying('中国', cn);
    expect(state.text.replace(/\s/g, '')).toBe('中国');
  });
});
