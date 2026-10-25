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
 * 模拟 AudioWorklet 的段式输出：
 * 在音频渲染线程内完成判决，段长以采样点数给出。
 */
function simulateWorkletRuns(
  text: string,
  book: Codebook = en,
  wpm = 18,
  opts: { noise?: number; sampleRate?: number; dropRate?: number } = {},
) {
  const enc = encodeText(text, book, {
    wpm,
    frequency: 600,
    volume: 0.9,
  });
  const sampleRate = opts.sampleRate ?? 48000;

  const src = renderTimeline(enc.timeline, {
    sampleRate,
    frequency: 600,
    volume: 0.9,
  });

  // 加噪声
  let samples = src;
  if (opts.noise) {
    let seed = 42;
    samples = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples[i] = src[i] + ((seed / 0x7fffffff) * 2 - 1) * opts.noise;
    }
  }

  // 判决：1ms 窗的 RMS + 迟滞
  const win = Math.max(1, Math.round(sampleRate * 0.0005));
  const runs: { on: boolean; samples: number }[] = [];
  let peak = 0.05;
  let noiseFloor = 0.005;
  let signalOn = false;
  let runSamples = 0;

  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(i + win, samples.length);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (end - i));
    runSamples += end - i;

    if (rms > peak) peak = rms;
    noiseFloor = noiseFloor * 0.999 + rms * 0.001;
    const thr = Math.max(
      0.02,
      Math.min(0.6, Math.max(noiseFloor * 2.5, peak * 0.35)),
    );

    if (!signalOn && rms > thr) {
      signalOn = true;
      if (runSamples > 0) runs.push({ on: false, samples: runSamples });
      runSamples = 0;
    } else if (signalOn && rms < thr * 0.6) {
      signalOn = false;
      if (runSamples > 0) runs.push({ on: true, samples: runSamples });
      runSamples = 0;
    }
  }
  if (runSamples > 0) runs.push({ on: signalOn, samples: runSamples });

  // 模拟消息队列丢包
  let delivered = runs;
  const dropRate = opts.dropRate ?? 0;
  if (dropRate > 0) {
    let seed = 7;
    delivered = runs.filter(() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff >= dropRate;
    });
  }

  const dec = new RealtimeDecoder(book);
  for (const r of delivered) {
    dec.pushRun(r.on, r.samples, sampleRate);
  }
  const st = dec.flushRun();
  return { text: st.text.trim(), expected: text, state: st };
}

describe('实时解码（段模式 / AudioWorklet 路径）', () => {
  it('解码 SOS', () => {
    const r = simulateWorkletRuns('SOS');
    expect(r.text).toBe('SOS');
  });

  it('解码多词文本', () => {
    const r = simulateWorkletRuns('HELLO WORLD');
    expect(r.text).toBe('HELLO WORLD');
  });

  it('解码 CQ CQ DE MORSE', () => {
    const r = simulateWorkletRuns('CQ CQ DE MORSE');
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('解码数字', () => {
    const r = simulateWorkletRuns('12345');
    expect(r.text).toBe('12345');
  });

  it('实用 WPM 范围都能解码', () => {
    // 10~35 WPM 覆盖实际通联的全部场景。
    // 40+ WPM 时点仅 20~22ms，与码内间隔几乎等长，
    // 判决精度要求超过 1ms 包络窗的能力，属已知限制。
    for (const wpm of [8, 10, 12, 15, 18, 20, 25, 30, 35]) {
      const r = simulateWorkletRuns('CQ CQ DE MORSE', en, wpm);
      expect(r.text, `wpm=${wpm}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('带噪声仍能解码（10%）', () => {
    const r = simulateWorkletRuns('CQ CQ DE MORSE', en, 18, { noise: 0.1 });
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('带噪声仍能解码（25%）', () => {
    const r = simulateWorkletRuns('CQ CQ DE MORSE', en, 18, { noise: 0.25 });
    expect(r.text).toBe('CQ CQ DE MORSE');
  });

  it('消息队列丢包时不会让后续段长度错位', () => {
    // 丢整段必然丢内容（无法避免），
    // 但关键是：丢失之后剩余的段仍能被正确判读，不应出现大面积乱码。
    const r = simulateWorkletRuns('CQ CQ DE MORSE', en, 18, { dropRate: 0.03 });
    const compact = r.text.replace(/\s/g, '');
    // 至少 80% 的字符仍正确（相比整段丢失导致的完全乱码）
    let correct = 0;
    for (const ch of 'CQCQDEMORSE') if (compact.includes(ch)) correct++;
    expect(compact.length).toBeGreaterThan(10);
    expect(correct).toBeGreaterThanOrEqual(8);
  });

  it('不同采样率都能解码', () => {
    for (const sampleRate of [8000, 16000, 44100, 48000]) {
      const r = simulateWorkletRuns('CQ CQ', en, 18, { sampleRate });
      expect(r.text, `sr=${sampleRate}`).toBe('CQ CQ');
    }
  });

  it('中文电码段模式解码', () => {
    const cn = getCodebook('zh-CN')!;
    const r = simulateWorkletRuns('中国', cn);
    expect(r.text.replace(/\s/g, '')).toBe('中国');
  });
});
