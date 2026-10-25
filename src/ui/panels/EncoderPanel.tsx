import { useMemo, useState, useRef, useEffect } from 'react';
import { encodeText, type Codebook } from '@core/index';
import { MorseText } from '../components/MorseText';
import { Waveform, type WaveMark } from '../components/Waveform';
import {
  playTimeline,
  stopPlayback,
  onPlayState,
  bufferToWavBlob,
  resumeAudio,
  renderToBuffer,
} from '../platform/web-audio';
import { saveWav, onDesktopMenu } from '../platform/desktop-bridge';
import type { ToastFn } from '../types';

interface Props {
  codebook: Codebook;
  wpm: number;
  setWpm: (v: number) => void;
  frequency: number;
  setFrequency: (v: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  waveform: 'sine' | 'square' | 'triangle';
  setWaveform: (v: 'sine' | 'square' | 'triangle') => void;
  toast: ToastFn;
}

const PRESETS = [
  { label: 'CQ', text: 'CQ CQ DE MORSE' },
  { label: 'SOS', text: 'SOS' },
  { label: '呼号', text: 'CQ CQ DE B1ABC K' },
  { label: '求救', text: 'SOS SOS SOS' },
];

/** 编码面板：文本 -> 摩斯 -> 音频 */
export function EncoderPanel(props: Props) {
  const { codebook, toast } = props;
  const [text, setText] = useState('CQ CQ DE MORSE');
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => onPlayState((s) => setPlaying(s === 'playing')), []);

  const encoded = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return encodeText(text, codebook, {
        wpm: props.wpm,
        frequency: props.frequency,
        volume: props.volume,
      });
    } catch (e) {
      return null;
    }
  }, [text, codebook, props.wpm, props.frequency, props.volume]);

  /** 信号带（用于可视化） */
  const marks = useMemo<WaveMark[]>(() => {
    if (!encoded) return [];
    const out: WaveMark[] = [];
    let t = 0;
    for (const el of encoded.timeline) {
      const dur = el.durationMs / 1000;
      out.push({ start: t, end: t + dur, on: el.kind !== 'gap' });
      t += dur;
    }
    return out;
  }, [encoded]);

  const handlePlay = async () => {
    if (!encoded) return;
    try {
      await playTimeline(encoded.timeline, {
        frequency: props.frequency,
        volume: props.volume,
        waveform: props.waveform,
        onProgress: setProgress,
      });
    } catch (e) {
      toast((e as Error).message || '播放失败', 'err');
    }
  };

  const handleExport = async () => {
    if (!encoded) return;
    try {
      await resumeAudio();
      const buf = await renderToBuffer(encoded.timeline, {
        frequency: props.frequency,
        volume: props.volume,
        waveform: props.waveform,
      });
      const blob = bufferToWavBlob(buf);
      const name = `morse-${codebook.id}-${Date.now().toString(36)}.wav`;
      const r = await saveWav(name, await blob.arrayBuffer());
      if (r.ok) {
        toast(
          `已导出 WAV (${(blob.size / 1024).toFixed(0)} KB) · ${r.location}`,
          'ok',
        );
      } else {
        toast(`导出未完成：${r.location}`, 'err');
      }
    } catch (e) {
      toast((e as Error).message || '导出失败', 'err');
    }
  };

  // 桌面端菜单「导出 WAV」
  useEffect(() => {
    return onDesktopMenu('export-wav', () => {
      void handleExport();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, props.frequency, props.volume, props.waveform]);

  const unsupported = encoded?.unsupported ?? [];

  return (
    <div className="panels">
      {/* 左：输入 + 参数 */}
      <div>
        <div className="card">
          <div className="card-head">
            文字输入
            <span className="spacer" />
            <span className="hint">{codebook.displayName ?? codebook.name}</span>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入要发送的文字…"
            spellCheck={false}
            rows={4}
          />

          <div className="btn-row" style={{ marginTop: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="btn sm"
                onClick={() => setText(p.text)}
              >
                {p.label}
              </button>
            ))}
            {text && (
              <button className="btn sm" onClick={() => setText('')}>
                清空
              </button>
            )}
          </div>

          {unsupported.length > 0 && (
            <div className="status" style={{ marginTop: 8 }}>
              <span className="dot-status warn" />
              <span>
                当前码表不支持:{' '}
                <code style={{ color: 'var(--warn)' }}>
                  {unsupported.slice(0, 12).join(' ')}
                </code>
                {unsupported.length > 12 && ` 等 ${unsupported.length} 个字符`}
              </span>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">发送参数</div>

          <div className="slider-row">
            <label>速度</label>
            <input
              type="range"
              min={5}
              max={40}
              step={1}
              value={props.wpm}
              onChange={(e) => props.setWpm(Number(e.target.value))}
            />
            <span className="val">{props.wpm} WPM</span>
          </div>

          <div className="slider-row">
            <label>音高</label>
            <input
              type="range"
              min={300}
              max={1400}
              step={10}
              value={props.frequency}
              onChange={(e) => props.setFrequency(Number(e.target.value))}
            />
            <span className="val">{props.frequency} Hz</span>
          </div>

          <div className="slider-row">
            <label>音量</label>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={props.volume}
              onChange={(e) => props.setVolume(Number(e.target.value))}
            />
            <span className="val">{Math.round(props.volume * 100)}%</span>
          </div>

          <label className="field">
            <span className="lbl">波形</span>
            <select
              value={props.waveform}
              onChange={(e) =>
                props.setWaveform(e.target.value as 'sine' | 'square' | 'triangle')
              }
            >
              <option value="sine">正弦波（标准，柔和）</option>
              <option value="square">方波（尖锐，业余电台常用）</option>
              <option value="triangle">三角波</option>
            </select>
          </label>

          <div className="btn-row">
            <button
              className="btn primary"
              onClick={handlePlay}
              disabled={!encoded}
            >
              {playing ? '■ 停止' : '▶ 播放'}
            </button>
            <button
              className="btn"
              onClick={() => {
                stopPlayback();
                setProgress(0);
              }}
              disabled={!playing}
            >
              停止
            </button>
            <button className="btn" onClick={handleExport} disabled={!encoded}>
              ⬇ 导出 WAV
            </button>
          </div>

          {playing && (
            <div className="progress">
              <div style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* 右：输出 */}
      <div>
        <div className="card">
          <div className="card-head">
            摩斯码
            <span className="spacer" />
            <span className="hint">
              {codebook.system === 'morse' ? '点划符号' : '数字电码'}
            </span>
          </div>
          <MorseText morse={encoded?.morse ?? ''} />
          <div className="stats">
            <span>
              时长 <b>{((encoded?.durationMs ?? 0) / 1000).toFixed(1)}s</b>
            </span>
            <span>
              点长 <b>{encoded?.dotMs.toFixed(1) ?? 0}ms</b>
            </span>
            <span>
              符号 <b>{encoded?.units.length ?? 0}</b>
            </span>
            <span>
              字符 <b>{text.replace(/\s/g, '').length}</b>
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            信号带
            <span className="spacer" />
            <span className="hint">青=点 橙=划</span>
          </div>
          {marks.length > 0 ? (
            <Waveform marks={marks} height={120} />
          ) : (
            <div className="wave">
              <div className="wave-empty">输入文字后显示信号带</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
