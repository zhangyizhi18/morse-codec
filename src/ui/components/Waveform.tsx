import { useEffect, useRef } from 'react';

export interface WaveMark {
  /** 起始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** true = 信号，false = 间隔 */
  on: boolean;
}

/**
 * 音频波形 / 信号带可视化。
 *
 * 传入采样与总时长，绘制包络；
 * 也可传入 marks 绘制离散的点划信号带。
 */
export function Waveform({
  samples,
  sampleRate,
  marks,
  height = 110,
  color = '#38bdf8',
}: {
  samples?: Float32Array;
  sampleRate?: number;
  marks?: WaveMark[];
  height?: number;
  color?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    if (marks && marks.length > 0) {
      // 绘制信号带
      const total = marks[marks.length - 1].end || 1;
      for (const m of marks) {
        const x0 = (m.start / total) * width;
        const x1 = (m.end / total) * width;
        if (m.on) {
          const g = ctx.createLinearGradient(0, 0, 0, height);
          g.addColorStop(0, color);
          g.addColorStop(1, '#1e5f7a');
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = '#1b2740';
        }
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
      }
      // 中线
      ctx.strokeStyle = '#26334f';
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    if (samples && samples.length > 0 && sampleRate) {
      const total = samples.length / sampleRate;
      const mid = height / 2;

      // 网格
      ctx.strokeStyle = '#1b2740';
      ctx.lineWidth = 1;
      const secs = Math.min(10, Math.ceil(total));
      for (let i = 0; i <= secs; i++) {
        const x = (i / secs) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // 包络（min/max 峰值）
      const buckets = Math.max(1, Math.floor(width));
      const per = samples.length / buckets;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < buckets; i++) {
        const s = Math.floor(i * per);
        const e = Math.min(samples.length, Math.floor((i + 1) * per));
        if (e <= s) continue;
        let max = 0;
        let min = 0;
        for (let j = s; j < e; j++) {
          const v = samples[j];
          if (v > max) max = v;
          if (v < min) min = v;
        }
        const x = i;
        ctx.moveTo(x, mid - max * (mid - 3));
        ctx.lineTo(x, mid - min * (mid - 3));
      }
      ctx.stroke();

      // 中线
      ctx.strokeStyle = '#26334f';
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
    }
  }, [samples, sampleRate, marks, height, color]);

  return (
    <div className="wave">
      <canvas ref={ref} style={{ height: `${height}px` }} />
    </div>
  );
}
