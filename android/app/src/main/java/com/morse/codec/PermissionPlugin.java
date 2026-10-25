package com.morse.codec;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 运行时权限插件。
 *
 * Capacitor 8 移除了官方 @capacitor/permissions 插件，
 * 这里用原生 API 实现最小可用的权限查询/申请能力。
 *
 * 目前仅支持麦克风（RECORD_AUDIO）—— 实时接收摩斯信号所需。
 */
@CapacitorPlugin(
    name = "MorsePermissions",
    permissions = {
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
public class PermissionPlugin extends Plugin {

    /** 当前请求的权限别名（回调时使用） */
    private String pendingAlias = "microphone";

    /**
     * 查询权限状态。
     *
     * @return { state: "granted" | "denied" | "prompt" | "prompt-with-rationale" }
     */
    @PluginMethod
    public void check(PluginCall call) {
        String alias = call.getString("alias", "microphone");
        PermissionState state = getPermissionState(alias);
        call.resolve(stateResult(state));
    }

    /**
     * 申请权限。
     *
     * 回调名默认为 "permissionCallback"，可在调用时通过 callbackName 覆盖。
     */
    @PluginMethod
    public void request(PluginCall call) {
        String alias = call.getString("alias", "microphone");
        String callbackName = call.getString("callbackName", "permissionCallback");
        this.pendingAlias = alias;

        PermissionState state = getPermissionState(alias);
        if (state == PermissionState.GRANTED) {
            // 已授权，直接返回
            call.resolve(stateResult(state));
            return;
        }

        requestPermissionForAlias(alias, call, callbackName);
    }

    /** 构造 { state: ... } 结果对象 */
    private JSObject stateResult(PermissionState state) {
        JSObject ret = new JSObject();
        ret.put("state", state == null ? "denied" : state.name());
        return ret;
    }

    /**
     * 权限申请结果回调。
     *
     * Capacitor 要求用 @PermissionCallback 标注与 requestPermissionForAlias
     * 的 callbackName 对应的方法，否则请求无法完成。
     */
    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        PermissionState state = getPermissionState(pendingAlias);
        call.resolve(stateResult(state));
    }
}
