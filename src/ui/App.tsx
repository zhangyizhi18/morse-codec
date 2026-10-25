import { useCallback, useEffect, useMemo, useState } from 'react';
import { CODEBOOKS, getCodebook, type Codebook } from '@core/index';
import { EncoderPanel } from './panels/EncoderPanel';
import { DecoderPanel } from './panels/DecoderPanel';
import { CodebookPanel } from './panels/CodebookPanel';
import { LivePanel } from './panels/LivePanel';
import type { ToastFn } from './types';

type Tab = 'encode' | 'decode' | 'live' | 'codebook';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'ok' | 'err';
}

/** 设置持久化 */
const STORAGE_KEY = 'morse-codec-settings';

interface Settings {
  codebookId: string;
  wpm: number;
  frequency: number;
  volume: number;
  waveform: 'sine' | 'square' | 'triangle';
  tab: Tab;
}

const DEFAULTS: Settings = {
  codebookId: 'en',
  wpm: 18,
  frequency: 600,
  volume: 0.9,
  waveform: 'sine',
  tab: 'encode',
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

export function App() {
  const initial = useMemo(loadSettings, []);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [codebookId, setCodebookId] = useState(initial.codebookId);
  const [wpm, setWpm] = useState(initial.wpm);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [volume, setVolume] = useState(initial.volume);
  const [waveform, setWaveform] = useState<'sine' | 'square' | 'triangle'>(
    initial.waveform,
  );
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const codebook: Codebook = useMemo(
    () => getCodebook(codebookId) ?? CODEBOOKS[0],
    [codebookId],
  );

  // 持久化设置
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ codebookId, wpm, frequency, volume, waveform, tab }),
      );
    } catch {
      /* 忽略存储失败 */
    }
  }, [codebookId, wpm, frequency, volume, waveform, tab]);

  // Toast
  const toast = useCallback<ToastFn>((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const handleSelectCodebook = useCallback(
    (id: string) => {
      setCodebookId(id);
      toast(`已切换到 ${getCodebook(id)?.displayName ?? id}`, 'ok');
    },
    [toast],
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'encode', label: '调制' },
    { id: 'decode', label: '解调' },
    { id: 'live', label: '实时' },
    { id: 'codebook', label: '码表' },
  ];

  return (
    <div className="app">
      <header className="appbar">
        <h1>
          <span style={{ color: 'var(--accent)' }}>⌁</span>
          摩斯电码 · 调制解调
        </h1>
        <span className="badge">v1.0.0</span>

        <select
          value={codebookId}
          onChange={(e) => handleSelectCodebook(e.target.value)}
          style={{ width: 'auto', minWidth: 150, marginLeft: 8 }}
          aria-label="选择码表"
        >
          {CODEBOOKS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.displayName ?? b.name}
            </option>
          ))}
        </select>

        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === 'encode' && (
          <EncoderPanel
            codebook={codebook}
            wpm={wpm}
            setWpm={setWpm}
            frequency={frequency}
            setFrequency={setFrequency}
            volume={volume}
            setVolume={setVolume}
            waveform={waveform}
            setWaveform={setWaveform}
            toast={toast}
          />
        )}

        {tab === 'decode' && (
          <DecoderPanel codebook={codebook} toast={toast} />
        )}

        {tab === 'live' && (
          <LivePanel
            codebook={codebook}
            toast={toast}
            frequency={frequency}
          />
        )}

        {tab === 'codebook' && (
          <CodebookPanel
            codebook={codebook}
            onSelect={handleSelectCodebook}
          />
        )}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
