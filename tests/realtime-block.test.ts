import { describe, it, expect } from 'vitest';
import {
  RealtimeDecoder,
  getCodebook,
  encodeText,
  renderTimeline,
  type Codebook,
} from '../src/core';

const en = getCodebook('en')!;

/**
 * 模拟 PC 端发出音频 -> 安卓端实时监听的完整链路。
 *
 * 关键：用与 ScriptProcessor 相同的分块方式喂入（2048 帧/块），
 * 验证块模式解码的准确性。
 */
function simulateCrossDevice(
  text: string,
  book: Codebook = en,
  wpm = 18,
  opts: { noise?: number; chunk?: number; sampleRate?: number } = {},
) {
  const enc = encodeText(text, book, {
    wpm,
    frequency: 600,
    volume: 0.9,
  });
  const sampleRate = opts.sampleRate ?? 48000;

  // 用 PC 端的渲染器生成音频，再重采样到目标采样率
  const src = renderTimeline(enc.timeline, {
    sampleRate,
    frequency: 600,
    volume: 0.9,
  });

  // 加噪声（模拟环境噪声）
  let samples = src;
  if (opts.noise) {
    let seed = 42;
    samples = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples[i] = src[i] + ((seed / 0x7fffffff) * 2 - 1) * opts.noise;
    }
  }

  // 模拟 ScriptProcessor 分块回调
  const chunk = opts.chunk ?? 2048;
  const dec = new RealtimeDecoder(book);
  let state = dec.getState();

  for (let i = 0; i < samples.length; i += chunk) {
    const block = samples.subarray(i, Math.min(i + chunk, samples.length));
    state = dec.pushBlock(block, sampleRate);
  }
  state = dec.flushBlock();

  return { text: state.text.trim(), expected: text, state };
}

describe('实时解码（块模式）', () => {
  it('解码 SOS', () => {
    const r = simulateCrossDevice('SOS');
    expect(r.text).toBe('SOS');
  });

  it('解码多词文本', () => {
    const r = simulateCrossDevice('HELLO WORLD');
    expect(r.text).toBe('HELLO WORLD');
  });

  it('解码 CQ CQ DE MORSE', () => {
    const r = simulateCrossDevice('CQ CQ DE MORSE');
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('解码数字', () => {
    const r = simulateCrossDevice('12345');
    expect(r.text).toBe('12345');
  });

  it('不同 WPM 都能解码', () => {
    for (const wpm of [8, 12, 18, 25, 35, 45]) {
      const r = simulateCrossDevice('CQ CQ DE MORSE', en, wpm);
      expect(r.text, `wpm=${wpm}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('带噪声仍能解码（10%）', () => {
    const r = simulateCrossDevice('CQ CQ DE MORSE', en, 18, { noise: 0.1 });
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('带噪声仍能解码（25%）', () => {
    const r = simulateCrossDevice('CQ CQ DE MORSE', en, 18, { noise: 0.25 });
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('不同分块大小都能解码', () => {
    for (const chunk of [512, 1024, 2048, 4096]) {
      const r = simulateCrossDevice('CQ CQ', en, 18, { chunk });
      expect(r.text, `chunk=${chunk}`).toBe('CQ CQ');
    }
  });

  it('不同采样率都能解码', () => {
    for (const sampleRate of [8000, 16000, 44100, 48000]) {
      const r = simulateCrossDevice('CQ CQ', en, 18, { sampleRate });
      expect(r.text, `sr=${sampleRate}`).toBe('CQ CQ');
    }
  });

  it('中文电码块模式解码', () => {
    const cn = getCodebook('zh-CN')!;
    const r = simulateCrossDevice('中国', cn);
    expect(r.text.replace(/\s/g, '')).toBe('中国');
  });

  it('块模式能还原空格', () => {
    const r = simulateCrossDevice('A B C');
    expect(r.text).toBe('A B C');
  });
});
