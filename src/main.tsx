import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { setWorkletUrl } from './ui/platform/audio-worklet-meter';
import './ui/styles.css';

// 注册 AudioWorklet 模块地址（实时解码依赖它保证音频块连续）。
// 脚本放在 public/ 下，Capacitor 会原样复制到 android assets，
// 保证与页面同源（Android WebView 的 https://localhost scheme 必需）。
setWorkletUrl('./morse-level-processor.js');

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 容器');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
