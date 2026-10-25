package com.morse.codec;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_MIC = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义权限插件（Capacitor 8 移除了官方 Permissions 插件）
        registerPlugin(PermissionPlugin.class);
        super.onCreate(savedInstanceState);

        // 修复 Capacitor 的音频采集权限缺陷（详见 onPermissionRequest 注释）
        applyWebChromeClientPermissionFix();
    }

    /**
     * 修复 Capacitor BridgeWebChromeClient 的媒体权限缺陷。
     *
     * <p>问题：Capacitor 8 的 onPermissionRequest 在申请音频采集时，
     * 会同时请求 {@code MODIFY_AUDIO_SETTINGS}。但该权限属于
     * normal 保护级别，不是运行时权限，系统既不会授予也不在可请求列表中。
     *
     * <p>Capacitor 的权限回调逻辑是「所有请求项都必须 granted」，
     * 因此 MODIFY_AUDIO_SETTINGS 永远返回 false，
     * 导致 {@code request.deny()} 被调用，
     * 最终 getUserMedia 抛出 NotAllowedError —— 即使用户已授权麦克风。
     *
     * <p>修复：自行处理 WebView 的权限请求，只检查真正需要运行时授权的
     * {@code RECORD_AUDIO}，避免被 normal 权限拖累。
     */
    private void applyWebChromeClientPermissionFix() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        webView.setWebChromeClient(
            new BridgeWebChromeClient(getBridge()) {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            wantsAudio = true;
                            break;
                        }
                    }

                    if (!wantsAudio) {
                        // 非音频请求交回默认处理
                        super.onPermissionRequest(request);
                        return;
                    }

                    // 只检查 RECORD_AUDIO（真正的运行时权限）
                    boolean granted = checkSelfPermission(
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED;

                    if (granted) {
                        request.grant(request.getResources());
                    } else {
                        request.deny();
                    }
                }
            }
        );
    }

    /**
     * 首次进入时主动申请麦克风权限。
     */
    @Override
    public void onStart() {
        super.onStart();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    REQUEST_MIC
                );
            }
        }
    }
}
