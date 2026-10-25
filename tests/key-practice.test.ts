import { describe, it, expect } from 'vitest';
import { KeyPracticer, getCodebook } from '../src/core';

const en = getCodebook('en')!;

/** 模拟按键序列，返回每次按键的判定 */
function play(
  kp: KeyPracticer,
  pattern: string,
  unitMs: number,
  opts: { jitter?: number; startAt?: number } = {},
) {
  let t = opts.startAt ?? 0;
  const jitter = opts.jitter ?? 0;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };

  const strokes = [];
  for (let i = 0; i < pattern.length; i++) {
    const mark = pattern[i];
    const dur = (mark === '.' ? 1 : 3) * unitMs;
    const actual = dur + rnd() * jitter * unitMs;

    kp.pressDown(t);
    t += actual;
    const s = kp.pressUp(t);
    if (s) strokes.push(s);

    t += unitMs; // 码内间隔
  }
  return { strokes, endAt: t };
}

/**
 * 完成起步校准。
 *
 * 判定器需要前 4 段样本才能确定 1u 基准（取最小值），
 * 因此测试里先发 4 个点来校准。
 */
function calibrate(kp: KeyPracticer, unitMs: number, startAt = 0) {
  let t = startAt;
  for (let i = 0; i < 4; i++) {
    kp.pressDown(t);
    t += unitMs;
    kp.pressUp(t);
    t += unitMs;
  }
  return t;
}

describe('手键练习判定器', () => {
  it('前 4 段样本后建立单位基准（取最小值）', () => {
    const kp = new KeyPracticer(en);
    const unit = 67;

    for (let i = 0; i < 3; i++) {
      kp.pressDown(i * unit * 2);
      kp.pressUp(i * unit * 2 + unit);
    }
    expect(kp.getState().unitMs).toBe(0);

    kp.pressDown(unit * 6);
    kp.pressUp(unit * 7);
    expect(kp.getState().unitMs).toBeCloseTo(unit, 0);
  });

  it('校准期混入划时，最小值仍是 1u', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const durs = [unit * 3, unit, unit * 3, unit];
    let t = 0;
    for (const d of durs) {
      kp.pressDown(t);
      t += d;
      kp.pressUp(t);
      t += unit;
    }
    expect(kp.getState().unitMs).toBeCloseTo(unit, 0);
    expect(kp.getState().pending).toBe('-.-.');
  });

  it('按 1u 与 3u 正确判出点与划', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t = calibrate(kp, unit);
    const { strokes } = play(kp, '-.-.', unit, { startAt: t });

    expect(strokes.map((s) => s.mark).join('')).toBe('-.-.');
  });

  it('不同速度都能判对', () => {
    for (const unit of [40, 60, 80, 120, 200]) {
      const kp = new KeyPracticer(en);
      const t = calibrate(kp, unit);
      const { strokes } = play(kp, '.-..', unit, { startAt: t });
      expect(strokes.map((s) => s.mark).join(''), `unit=${unit}`).toBe('.-..');
    }
  });

  it('时长准确时评为 good', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t = calibrate(kp, unit);
    const { strokes } = play(kp, '.-', unit, { startAt: t });
    expect(strokes.every((s) => s.quality === 'good')).toBe(true);
  });

  it('小幅抖动仍评为 good 或 ok', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t = calibrate(kp, unit);
    const { strokes } = play(kp, '.-.-', unit, { jitter: 0.15, startAt: t });
    for (const s of strokes) {
      expect(['good', 'ok']).toContain(s.quality);
    }
  });

  it('落在模糊区标为 shaky', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t = calibrate(kp, unit);
    kp.pressDown(t);
    const s = kp.pressUp(t + unit * 2);

    expect(s!.quality).toBe('shaky');
    expect(kp.getState().shakyCount).toBe(1);
  });

  it('单位估计会跟随用户节奏收敛', () => {
    const kp = new KeyPracticer(en);
    let t = calibrate(kp, 60);
    for (let i = 0; i < 12; i++) {
      kp.pressDown(t);
      t += 80;
      kp.pressUp(t);
      t += 80;
    }
    expect(kp.getState().unitMs).toBeGreaterThan(68);
    expect(kp.getState().unitMs).toBeLessThan(92);
  });

  it('停顿 3u 自动切分字符并解出字母', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    let t = calibrate(kp, unit);
    kp.clearOutput();

    for (let i = 0; i < 3; i++) {
      kp.pressDown(t);
      t += unit;
      kp.pressUp(t);
      t += unit;
    }
    t += unit * 3.5;
    const ch = kp.idle(t);

    expect(ch).not.toBeNull();
    expect(ch!.code).toBe('...');
    expect(ch!.char).toBe('S');
  });

  it('多个字符依次解出', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    let t = calibrate(kp, unit);
    kp.clearOutput();

    const out: string[] = [];
    for (const ch of ['S', 'O', 'S']) {
      const code = en.entries[ch];
      for (let i = 0; i < code.length; i++) {
        kp.pressDown(t);
        t += (code[i] === '.' ? 1 : 3) * unit;
        kp.pressUp(t);
        t += unit;
      }
      t += unit * 3.5;
      const r = kp.idle(t);
      if (r) out.push(r.char);
    }

    expect(out.join('')).toBe('SOS');
  });

  it('停顿不足 3u 不切分', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t0 = calibrate(kp, unit);
    kp.clearOutput();

    kp.pressDown(t0);
    kp.pressUp(t0 + unit);
    const ch = kp.idle(t0 + unit + unit * 1.5);
    expect(ch).toBeNull();
    expect(kp.getState().pending).toBe('.');
  });

  it('未知码字解为 ?', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    let t = calibrate(kp, unit);
    kp.clearOutput();

    for (let i = 0; i < 8; i++) {
      kp.pressDown(t);
      t += unit;
      kp.pressUp(t);
      t += unit;
    }
    t += unit * 4;
    const ch = kp.idle(t);
    expect(ch!.char).toBe('?');
  });

  it('按住不放时 flush 能结算当前按键', () => {
    const kp = new KeyPracticer(en);
    const unit = 60;
    const t = calibrate(kp, unit);
    kp.clearOutput();

    kp.pressDown(t);
    const ch = kp.flush(t + unit * 3);
    expect(ch).not.toBeNull();
    expect(ch!.code).toBe('-');
  });

  it('clearOutput 保留学到的单位', () => {
    const kp = new KeyPracticer(en);
    play(kp, '.-', 60);
    const unitBefore = kp.getState().unitMs;
    kp.clearOutput();
    expect(kp.getState().unitMs).toBe(unitBefore);
    expect(kp.getState().chars).toHaveLength(0);
    expect(kp.getState().pending).toBe('');
  });

  it('reset 清空一切', () => {
    const kp = new KeyPracticer(en);
    calibrate(kp, 60);
    kp.reset();
    const st = kp.getState();
    expect(st.unitMs).toBe(0);
    expect(st.pending).toBe('');
    expect(st.chars).toHaveLength(0);
    expect(st.strokeCount).toBe(0);
  });

  it('WPM 由单位时长正确反推', () => {
    const kp = new KeyPracticer(en);
    calibrate(kp, 60);
    expect(kp.getState().wpm).toBeCloseTo(20, 0);
  });

  it('重复按下被忽略', () => {
    const kp = new KeyPracticer(en);
    kp.pressDown(0);
    kp.pressDown(30);
    const s = kp.pressUp(60);
    expect(s!.durationMs).toBeCloseTo(60, 0);
  });

  it('未按下时松开返回 null', () => {
    const kp = new KeyPracticer(en);
    expect(kp.pressUp(100)).toBeNull();
  });

  it('真实人手抖动（±12%）下能解出完整句子', () => {
    const kp = new KeyPracticer(en);
    const unit = 130;
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const human = (base: number) => base * (1 + (rnd() * 2 - 1) * 0.12);

    let t = 0;
    const out: string[] = [];
    for (const ch of 'CQTEST') {
      const code = en.entries[ch];
      for (let i = 0; i < code.length; i++) {
        const dur = human(code[i] === '.' ? unit : unit * 3);
        kp.pressDown(t);
        t += dur;
        kp.pressUp(t);
        t += human(unit);
      }
      t += unit * 3.2;
      const r = kp.idle(t);
      if (r) out.push(r.char);
    }
    expect(out.join('')).toBe('CQTEST');
  });
});
