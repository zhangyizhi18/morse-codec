import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RealtimeDecoder,
  decodeAudio,
  estimateWpm,
  type Codebook,
  type DecodeResult,
} from '@core/index';
import { MorseText } from '../components/MorseText';
import {
  AudioRecorder,
  KeyTone,
  decodeAudioFile,
  createCollector,
  type AudioCollector,
} from '../platform/web-audio';
import type { ToastFn } from '../types';

interface Props {
  codebook: Codebook;
  toast: ToastFn;
  /** 音高（Hz），供手键练习使用 */
  frequency: number;
}

/**
 * 实时接收面板。
 *
 * 两种模式：
 *  1. 实时监听：麦克风持续采集，用 RealtimeDecoder 边收边出字
 *  2. 录音解码：录制一段音频后用离线解码器处理
 */
export function LivePanel({ codebook, toast, frequency }: Props) {
  const [mode, setMode] = useState<'listen' | 'record'>('listen');
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [text, setText] = useState('');
  const [morse, setMorse] = useState('');
  const [unitMs, setUnitMs] = useState<number | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const [micState, setMicState] = useState<string>('unknown');
  const [diagText, setDiagText] = useState<string | null>(null);
  /** 采集是否保证音频块连续（AudioWorklet=true） */
  const [captureContinuous, setCaptureContinuous] = useState(true);

  const meterRef = useRef<AudioCollector | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const decoderRef = useRef<RealtimeDecoder | null>(null);
  const lastTextRef = useRef('');

  // 进入页面时检查麦克风权限状态
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { checkMicrophonePermission } = await import(
        '../platform/permission-bridge'
      );
      const s = await checkMicrophonePermission();
      if (!cancelled) {
        setMicState(s);
        if (s === 'denied') {
          setPermissionHint(
            '麦克风权限未开启，请到系统设置 → 应用 → 摩斯电码 → 权限中开启',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 实时监听 ────────────────────────────────
  const startListening = async () => {
    try {
      const decoder = new RealtimeDecoder(codebook);
      decoderRef.current = decoder;
      lastTextRef.current = '';

      // 优先用 AudioWorklet（音频块连续）；不可用时回退 ScriptProcessor
      const { collector, continuous } = await createCollector();
      if (!continuous) {
        console.warn(
          '[morse] AudioWorklet 不可用，已回退 ScriptProcessor（可能丢块，解码精度下降）',
        );
      }
      setCaptureContinuous(continuous);

      await collector.start(
        // 段模式：段长由 AudioWorklet 在音频线程精确计数，
        // 不受消息队列丢包影响
        (run, sampleRate) => {
          const state = run.noise
            ? decoder.rejectNoise()
            : decoder.pushRun(run.on, run.samples, sampleRate);
          // 仅在文本变化时更新，避免高频渲染
          if (state.text !== lastTextRef.current) {
            lastTextRef.current = state.text;
            setText(state.text);
          }
          setConfidence(state.confidence);
          if (state.locked) setUnitMs(state.unitMs);
        },
        (lvl: number) => {
          setLevel(lvl);
        },
      );
      meterRef.current = collector;
      setListening(true);
      setPermissionHint(null);
      setMicState('granted');
      toast('开始监听麦克风', 'ok');
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('权限')) {
        setPermissionHint(
          '请在系统设置 → 应用 → 摩斯电码 → 权限中开启「麦克风」',
        );
        setMicState('denied');
      } else {
        setPermissionHint(msg || '麦克风不可用');
      }
      toast(`无法访问麦克风：${msg || '未知错误'}`, 'err');

      // 采集诊断信息，便于定位真机上的具体原因
      void (async () => {
        try {
          const { diagnoseMicrophone } = await import(
            '../platform/web-audio'
          );
          const d = await diagnoseMicrophone();
          console.log('[morse] 麦克风诊断:', JSON.stringify(d));
          setDiagText(
            `平台=${d.platform} 安全上下文=${d.secureContext} ` +
              `权限=${d.permissionState} 输入设备=${d.inputDevices.length}` +
              (d.lastError ? ` 错误=${d.lastError}` : ''),
          );
        } catch {
          /* 诊断失败不影响主流程 */
        }
      })();
    }
  };

  /** 运行一次麦克风诊断 */
  const runDiagnostic = async () => {
    setDiagText('诊断中…');
    try {
      const { diagnoseMicrophone } = await import('../platform/web-audio');
      const d = await diagnoseMicrophone();
      const text =
        `平台: ${d.platform}\n` +
        `安全上下文: ${d.secureContext}\n` +
        `权限状态: ${d.permissionState}\n` +
        `输入设备数: ${d.inputDevices.length}\n` +
        d.inputDevices.map((x, i) => `  ${i + 1}. ${x.label}`).join('\n') +
        (d.lastError ? `\n错误: ${d.lastError}` : '');
      setDiagText(text);
      console.log('[morse] 诊断:', text);
    } catch (e) {
      setDiagText(`诊断失败: ${(e as Error).message}`);
    }
  };

  const stopListening = () => {
    const decoder = decoderRef.current;
    if (decoder) {
      // 块模式收尾：只冲刷累积的码字，不补造 mark
      const state = decoder.flushBlock();
      lastTextRef.current = state.text;
      setText(state.text);
    }
    meterRef.current?.stop();
    meterRef.current = null;
    decoderRef.current = null;
    setListening(false);
    setLevel(0);
  };

  // 码表切换时同步
  useEffect(() => {
    decoderRef.current?.setCodebook(codebook);
  }, [codebook]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      meterRef.current?.stop();
      recorderRef.current?.stop().catch(() => undefined);
    };
  }, []);

  // ── 录音解码 ────────────────────────────────
  const startRecording = async () => {
    try {
      const rec = new AudioRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
      toast('开始录音', 'ok');
    } catch (e) {
      toast(
        `无法访问麦克风: ${(e as Error).message || '权限被拒绝'}`,
        'err',
      );
    }
  };

  const stopRecording = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    try {
      const blob = await rec.stop();
      recorderRef.current = null;
      setRecording(false);

      const { samples, sampleRate } = await decodeAudioFile(blob);
      const r: DecodeResult = decodeAudio(samples, sampleRate, codebook);
      setText(r.text);
      setMorse(r.morse);
      setUnitMs(r.detectedDotMs);
      setConfidence(r.confidence);
      toast(`录音解码完成 (${r.charCount} 字符)`, 'ok');
    } catch (e) {
      toast((e as Error).message || '录音失败', 'err');
      setRecording(false);
    }
  };

  // ── 手动发报练习（手键） ────────────────────
  const [keyDown, setKeyDown] = useState(false);
  /** 按下的起始时刻，用于显示按压时长 */
  const [keyHeldMs, setKeyHeldMs] = useState(0);
  const keyToneRef = useRef<KeyTone | null>(null);
  const keyStartRef = useRef(0);
  const holdTimerRef = useRef<number | null>(null);
  /** 当前按下的 pointerId（用于避免 pointerup 重复触发、以及区分 touch 兜底） */
  const lastPointerIdRef = useRef<number | null>(null);
  /** 按键是否处于按下状态（同步标志，防止连点穿透） */
  const keyActiveRef = useRef(false);

  if (!keyToneRef.current) {
    keyToneRef.current = new KeyTone(600, 0.9);
  }

  /** 按下：开始持续发报 */
  const keyDownHandler = useCallback(() => {
    // 用同步标志位判断，避免 press() 的异步等待期被连点穿透
    if (keyActiveRef.current) return;
    keyActiveRef.current = true;

    keyStartRef.current = performance.now();
    setKeyDown(true);
    setKeyHeldMs(0);

    // 持续更新按压时长
    const tick = () => {
      setKeyHeldMs(performance.now() - keyStartRef.current);
      holdTimerRef.current = window.setTimeout(tick, 50);
    };
    holdTimerRef.current = window.setTimeout(tick, 50);

    // 优先同步发声（音频管线已预热时零延迟）
    const ok = keyToneRef.current?.pressNow();
    if (!ok) {
      // 未预热：退化为异步
      void keyToneRef.current?.press().catch(() => {
        /* AudioContext 不可用时静默降级 */
      });
    }
  }, []);

  /** 松开：停止发报 */
  const keyUpHandler = useCallback(() => {
    keyActiveRef.current = false;
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    keyToneRef.current?.release();
    setKeyDown(false);
    setKeyHeldMs(0);
  }, []);

  // 物理键盘：空格按住发报
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) =>
      e.code === 'Space' || e.key === ' ';

    const down = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      e.preventDefault();
      keyDownHandler();
    };
    const up = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      e.preventDefault();
      keyUpHandler();
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [keyDownHandler, keyUpHandler]);

  // 卸载时确保停止发声
  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      keyToneRef.current?.release();
      keyToneRef.current?.dispose();
    };
  }, []);

  // 音高变化时同步到按键音
  useEffect(() => {
    keyToneRef.current?.setFrequency(frequency);
  }, [frequency]);

  // 进入页面即预热音频管线
  // （实测 Android WebView 首次 new AudioContext() 需 130~290ms，
  //   若等到按键才创建，手感会非常迟钝）
  useEffect(() => {
    const id = window.setTimeout(() => {
      void keyToneRef.current?.warmup();
    }, 300);
    return () => clearTimeout(id);
  }, []);

  // 用户首次与页面交互时也预热（部分 WebView 需要手势才能启动 AudioContext）
  useEffect(() => {
    const warm = () => {
      void keyToneRef.current?.warmup();
    };
    window.addEventListener('pointerdown', warm, { once: true });
    window.addEventListener('touchstart', warm, { once: true });
    return () => {
      window.removeEventListener('pointerdown', warm);
      window.removeEventListener('touchstart', warm);
    };
  }, []);

  const detectedWpm = unitMs ? estimateWpm(unitMs) : null;

  return (
    <div className="panels">
      <div>
        <div className="card">
          <div className="card-head">
            实时接收
            <span className="spacer" />
            <span className="hint">
              {listening ? '监听中' : recording ? '录音中' : '空闲'}
            </span>
          </div>

          {/* 麦克风权限状态 */}
          {micState !== 'granted' && (
            <div className="status" style={{ marginBottom: 10 }}>
              <span
                className={`dot-status ${
                  micState === 'denied' ? 'err' : 'warn'
                }`}
              />
              <span>
                麦克风权限：
                <b style={{ color: 'var(--warn)' }}>
                  {micState === 'denied'
                    ? '已拒绝'
                    : micState === 'prompt'
                      ? '待授权'
                      : '未知'}
                </b>
                {permissionHint ? ` — ${permissionHint}` : ''}
              </span>
            </div>
          )}

          <div className="tabs" style={{ marginBottom: 12, width: '100%' }}>
            <button
              className={mode === 'listen' ? 'active' : ''}
              style={{ flex: 1 }}
              onClick={() => {
                setMode('listen');
                if (recording) void stopRecording();
              }}
            >
              实时监听
            </button>
            <button
              className={mode === 'record' ? 'active' : ''}
              style={{ flex: 1 }}
              onClick={() => {
                setMode('record');
                if (listening) stopListening();
              }}
            >
              录音解码
            </button>
          </div>

          {mode === 'listen' ? (
            <>
              <div className="status">
                <span className={`dot-status ${listening ? 'live' : ''}`} />
                <span>
                  {listening
                    ? '正在监听，请用摩斯电键发送或播放音频'
                    : '点击开始监听'}
                </span>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="meter">
                  <div style={{ width: `${Math.min(100, level * 180)}%` }} />
                </div>
                <div className="stats">
                  <span>
                    电平 <b>{(level * 100).toFixed(1)}</b>
                  </span>
                  {unitMs && (
                    <span>
                      单位 <b>≈{unitMs.toFixed(0)}ms</b>
                    </span>
                  )}
                  {detectedWpm && (
                    <span>
                      速度 <b>≈{detectedWpm} WPM</b>
                    </span>
                  )}
                  <span>
                    置信 <b>{(confidence * 100).toFixed(0)}%</b>
                  </span>
                </div>
              </div>

              <div className="btn-row">
                {listening ? (
                  <button className="btn danger" onClick={stopListening}>
                    ■ 停止监听
                  </button>
                ) : (
                  <button className="btn primary" onClick={startListening}>
                    ● 开始监听
                  </button>
                )}
                {text && (
                  <button
                    className="btn sm"
                    onClick={() => {
                      setText('');
                      setMorse('');
                      lastTextRef.current = '';
                      decoderRef.current?.reset();
                    }}
                  >
                    清空
                  </button>
                )}
                <button className="btn sm" onClick={() => void runDiagnostic()}>
                  🔍 麦克风诊断
                </button>
              </div>

              {diagText && (
                <div
                  className="out"
                  style={{
                    fontSize: 11,
                    lineHeight: 1.6,
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {diagText}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="status">
                <span className={`dot-status ${recording ? 'live' : ''}`} />
                <span>
                  {recording
                    ? '正在录音…（再次点击结束）'
                    : '点击开始录音，录制摩斯信号'}
                </span>
              </div>
              <div className="btn-row">
                {recording ? (
                  <button
                    className="btn danger"
                    onClick={() => void stopRecording()}
                  >
                    ■ 停止录音并解码
                  </button>
                ) : (
                  <button className="btn primary" onClick={startRecording}>
                    ● 开始录音
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            电键练习
            <span className="spacer" />
            <span className="hint">
              按住发声 · 短按=点 长按=划
            </span>
          </div>

          {/*
            手键面板。
            触摸事件同时支持 Pointer Events 与传统 TouchEvent：
            - 现代 WebView（含 touch-action:none 的自动转换）走 Pointer 路径
            - 部分老旧 WebView / 定制 ROM 只派发 TouchEvent，需单独兜底
            用 ref 标记来源，避免同一次触摸被处理两遍。
          */}
          <div
            className={`keypad${keyDown ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="电键练习：按住发送"
            onPointerDown={(e) => {
              e.preventDefault();
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              lastPointerIdRef.current = e.pointerId;
              keyDownHandler();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              if (lastPointerIdRef.current === e.pointerId) {
                lastPointerIdRef.current = null;
                keyUpHandler();
              }
            }}
            onPointerCancel={() => {
              lastPointerIdRef.current = null;
              keyUpHandler();
            }}
            onPointerLeave={(e) => {
              // 指针移出且未捕获时释放
              if (
                lastPointerIdRef.current === e.pointerId &&
                !(e.target as HTMLElement).hasPointerCapture?.(e.pointerId)
              ) {
                lastPointerIdRef.current = null;
                keyUpHandler();
              }
            }}
            /* 传统 TouchEvent 兜底（老 WebView / 定制 ROM） */
            onTouchStart={(e) => {
              // 注：React 17+ 把 touchstart 注册为 passive listener，
              // preventDefault 无效且会打警告；
              // 阻止滚动交给 CSS 的 touch-action:none 处理。
              //
              // 若本次触摸已被 pointer 事件处理过（现代 WebView 会同时派发两者），
              // 则跳过，避免同一次按下被处理两遍。
              if (lastPointerIdRef.current !== null) return;
              keyDownHandler();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              // 同理：pointer 已在处理时忽略 touch 的结束
              if (lastPointerIdRef.current !== null) return;
              keyUpHandler();
            }}
            onTouchCancel={() => {
              if (lastPointerIdRef.current !== null) return;
              keyUpHandler();
            }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                keyDownHandler();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                keyUpHandler();
              }
            }}
          >
            <div>
              <span className={`key-indicator${keyDown ? ' on' : ''}`} />
              {keyDown ? '发送中' : '按住发送'}
            </div>
            <div className="hint">
              {keyDown
                ? `${Math.round(keyHeldMs)} ms`
                : '手指按住 / 空格键 / 鼠标左键'}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="card">
          <div className="card-head">
            识别结果
            <span className="spacer" />
            {text && <span className="hint">{text.length} 字符</span>}
          </div>
          <div
            className={`out${text ? '' : ' empty'}`}
            style={{ fontFamily: 'var(--sans)', fontSize: 15 }}
          >
            {text || (listening ? '等待信号…' : '暂无结果')}
          </div>
          {text && (
            <div className="btn-row">
              <button
                className="btn sm"
                onClick={() => {
                  void navigator.clipboard.writeText(text);
                  toast('已复制到剪贴板', 'ok');
                }}
              >
                复制结果
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">摩斯码</div>
          <MorseText morse={morse} />
        </div>
      </div>
    </div>
  );
}
