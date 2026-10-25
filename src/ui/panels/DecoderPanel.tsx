import { useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeAudio,
  estimateWpm,
  type Codebook,
  type DecodeResult,
} from '@core/index';
import { MorseText } from '../components/MorseText';
import { Waveform } from '../components/Waveform';
import { decodeAudioFile } from '../platform/web-audio';
import { getDesktop, onDesktopMenu } from '../platform/desktop-bridge';
import type { ToastFn } from '../types';

interface Props {
  codebook: Codebook;
  toast: ToastFn;
}

interface LoadedAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  name: string;
}

/** 解码面板：音频 -> 摩斯 -> 文字 */
export function DecoderPanel({ codebook, toast }: Props) {
  const [audio, setAudio] = useState<LoadedAudio | null>(null);
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [thresholdMode, setThresholdMode] = useState<'auto' | 'fixed'>('auto');
  const [fixedThreshold, setFixedThreshold] = useState(0.15);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 执行解码 */
  const runDecode = (a: LoadedAudio) => {
    try {
      const r = decodeAudio(a.samples, a.sampleRate, codebook, {
        thresholdMode,
        threshold: thresholdMode === 'fixed' ? fixedThreshold : undefined,
      });
      setResult(r);
    } catch (e) {
      toast((e as Error).message || '解码失败', 'err');
      setResult(null);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const { samples, sampleRate, durationMs } = await decodeAudioFile(file);
      const a: LoadedAudio = {
        samples,
        sampleRate,
        durationMs,
        name: file.name,
      };
      setAudio(a);
      runDecode(a);
      toast(
        `已载入 ${file.name} (${(durationMs / 1000).toFixed(1)}s)`,
        'ok',
      );
    } catch (e) {
      toast(
        `无法解码该文件: ${(e as Error).message || '格式不支持'}`,
        'err',
      );
    } finally {
      setBusy(false);
    }
  };

  /** 桌面端：原生对话框打开音频 */
  const handleDesktopOpen = async () => {
    const desktop = getDesktop();
    if (!desktop) return;
    setBusy(true);
    try {
      const picked = await desktop.openAudioFile();
      if (!picked) return;
      const { samples, sampleRate, durationMs } = await decodeAudioFile(
        new Blob([picked.data]),
      );
      const a: LoadedAudio = {
        samples,
        sampleRate,
        durationMs,
        name: picked.name,
      };
      setAudio(a);
      runDecode(a);
      toast(`已载入 ${picked.name} (${(durationMs / 1000).toFixed(1)}s)`, 'ok');
    } catch (e) {
      toast((e as Error).message || '无法打开文件', 'err');
    } finally {
      setBusy(false);
    }
  };

  // 桌面端菜单「打开音频文件」
  useEffect(() => {
    return onDesktopMenu('open-audio-file', () => {
      void handleDesktopOpen();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codebook, thresholdMode, fixedThreshold]);

  /** 重跑解码（参数变化时） */
  const reDecode = () => {
    if (audio) runDecode(audio);
  };

  const detectedWpm = estimateWpm(result?.detectedDotMs ?? null);

  /** 波形峰值（用于显示） */
  const peak = useMemo(() => {
    if (!audio) return 0;
    let m = 0;
    const step = Math.max(1, Math.floor(audio.samples.length / 200000));
    for (let i = 0; i < audio.samples.length; i += step) {
      const v = Math.abs(audio.samples[i]);
      if (v > m) m = v;
    }
    return m;
  }, [audio]);

  return (
    <div className="panels">
      {/* 左：输入 */}
      <div>
        <div className="card">
          <div className="card-head">
            音频输入
            <span className="spacer" />
            <span className="hint">wav / mp3 / ogg / m4a</span>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.m4a,.flac,.aac"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />

          <div className="btn-row" style={{ marginTop: 0 }}>
            <button
              className="btn primary"
              onClick={() => {
                // 桌面端走原生对话框，其它平台走 <input type=file>
                if (getDesktop()) {
                  void handleDesktopOpen();
                } else {
                  fileRef.current?.click();
                }
              }}
              disabled={busy}
            >
              {busy ? '解析中…' : '📂 选择音频文件'}
            </button>
            {audio && (
              <button
                className="btn sm"
                onClick={() => {
                  setAudio(null);
                  setResult(null);
                }}
              >
                清除
              </button>
            )}
          </div>

          {audio ? (
            <>
              <div className="status" style={{ marginTop: 10 }}>
                <span className="dot-status ok" />
                <span>
                  {audio.name} · {(audio.durationMs / 1000).toFixed(1)}s ·{' '}
                  {audio.sampleRate} Hz
                </span>
              </div>
              <div style={{ marginTop: 8 }}>
                <Waveform
                  samples={audio.samples}
                  sampleRate={audio.sampleRate}
                  height={130}
                />
              </div>
              {peak > 0 && (
                <div className="stats">
                  <span>
                    峰值 <b>{peak.toFixed(3)}</b>
                  </span>
                  <span>
                    采样点 <b>{audio.samples.length.toLocaleString()}</b>
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="wave" style={{ marginTop: 10 }}>
              <div className="wave-empty">
                选择一个音频文件开始解码
                <br />
                <span style={{ fontSize: 11, opacity: 0.7 }}>
                  也可用「实时接收」页录音后解码
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">解码参数</div>

          <label className="field">
            <span className="lbl">阈值策略</span>
            <select
              value={thresholdMode}
              onChange={(e) => {
                setThresholdMode(e.target.value as 'auto' | 'fixed');
                setTimeout(reDecode, 0);
              }}
            >
              <option value="auto">自适应（Otsu）— 推荐，抗噪声</option>
              <option value="fixed">固定阈值 — 手动指定</option>
            </select>
          </label>

          {thresholdMode === 'fixed' && (
            <div className="slider-row">
              <label>阈值</label>
              <input
                type="range"
                min={0.01}
                max={0.9}
                step={0.01}
                value={fixedThreshold}
                onChange={(e) => setFixedThreshold(Number(e.target.value))}
              />
              <span className="val">{fixedThreshold.toFixed(2)}</span>
            </div>
          )}

          <div className="btn-row">
            <button className="btn" onClick={reDecode} disabled={!audio}>
              重新解码
            </button>
          </div>
        </div>
      </div>

      {/* 右：结果 */}
      <div>
        <div className="card">
          <div className="card-head">
            解码结果
            <span className="spacer" />
            {result && (
              <span className="hint">
                置信度 {(result.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>

          {result && result.text ? (
            <>
              <div
                className="out"
                style={{
                  fontSize: 15,
                  lineHeight: 1.8,
                  fontFamily: 'var(--sans)',
                }}
              >
                {result.text}
              </div>
              <div className="stats">
                <span>
                  字符 <b>{result.charCount}</b>
                </span>
                {detectedWpm && (
                  <span>
                    速度 <b>≈{detectedWpm} WPM</b>
                  </span>
                )}
                {result.detectedDotMs && (
                  <span>
                    点长 <b>{result.detectedDotMs.toFixed(1)}ms</b>
                  </span>
                )}
                <span>
                  阈值 <b>{result.threshold.toFixed(3)}</b>
                </span>
                {result.unknownCount > 0 && (
                  <span style={{ color: 'var(--warn)' }}>
                    未识别 <b>{result.unknownCount}</b>
                  </span>
                )}
              </div>
              {result.text && (
                <div className="btn-row">
                  <button
                    className="btn sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(result.text);
                      toast('已复制到剪贴板', 'ok');
                    }}
                  >
                    复制结果
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="out empty">
              {audio ? '未识别出摩斯信号' : '载入音频后显示结果'}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">识别出的摩斯码</div>
          <MorseText morse={result?.morse ?? ''} />
        </div>

        {result?.runs && result.runs.length > 0 && (
          <div className="card">
            <div className="card-head">
              信号游程
              <span className="spacer" />
              <span className="hint">{result.runs.length} 段</span>
            </div>
            <div className="out" style={{ fontSize: 11, lineHeight: 1.7 }}>
              {result.runs.slice(0, 120).map((r, i) => (
                <span
                  key={i}
                  style={{
                    color: r.on ? 'var(--dot)' : 'var(--text-faint)',
                    marginRight: 5,
                  }}
                >
                  {r.on ? '█' : '·'}
                </span>
              ))}
              {result.runs.length > 120 && ' …'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
