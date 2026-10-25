import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.morse.codec',
  appName: '摩斯电码',
  webDir: 'dist',
  android: {
    // 允许 WebView 访问 file:// 与本地资源
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // 未使用原生插件时的占位
  },
};

export default config;
