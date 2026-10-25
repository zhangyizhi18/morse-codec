import { describe, it, expect } from 'vitest';
import {
  encodeWav,
  decodeWav,
  resample,
  toMono,
  renderTimeline,
  encodeText,
  getCodebook,
} from '../src/core';

const en = getCodebook('en')!;

describe('WAV 编解码', () => {
  it('编码后可解码回相同采样', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.8;
    }
    const wav = encodeWav(samples, 44100);
    const out = decodeWav(wav);
    expect(out.sampleRate).toBe(44100);
    expect(out.samples.length).toBe(1000);
    // 16bit 量化误差
    for (let i = 0; i < 1000; i += 100) {
      expect(Math.abs(out.samples[i] - samples[i])).toBeLessThan(0.001);
    }
  });

  it('WAV 头字段正确', () => {
    const wav = encodeWav(new Float32Array(100), 8000);
    const view = new DataView(wav);
    const str = (o: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(str(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('非法 WAV 抛出明确错误', () => {
    const bad = new ArrayBuffer(100);
    expect(() => decodeWav(bad)).toThrow(/WAV/);
  });

  it('往返完整音频波形', () => {
    const enc = encodeText('CQ', en, { wpm: 18, frequency: 600, volume: 0.9 });
    const samples = renderTimeline(enc.timeline, {
      sampleRate: 8000,
      frequency: 600,
      volume: 0.9,
    });
    const wav = encodeWav(samples, 8000);
    const out = decodeWav(wav);
    expect(out.samples.length).toBe(samples.length);
    expect(out.durationMs).toBeGreaterThan(0);
  });
});

describe('重采样与混音', () => {
  it('resample 改变采样率', () => {
    const src = new Float32Array(1000).fill(0.5);
    const up = resample(src, 8000, 16000);
    expect(up.length).toBe(2000);
    const down = resample(src, 16000, 8000);
    expect(down.length).toBe(500);
  });

  it('resample 同采样率直接返回', () => {
    const src = new Float32Array(100);
    expect(resample(src, 8000, 8000)).toBe(src);
  });

  it('toMono 取多声道平均', () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([0, 0, 0]);
    const out = toMono([a, b]);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it('toMono 单声道直通', () => {
    const a = new Float32Array([1, 2]);
    expect(toMono([a])).toBe(a);
  });
});
