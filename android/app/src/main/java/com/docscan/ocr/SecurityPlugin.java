package com.docscan.ocr;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FLAG_SECURE toggle: blocks screenshots / screen recording and hides the
 * app's content in the Recents switcher. The choice is persisted so it is
 * applied before the WebView draws on the next launch.
 */
@CapacitorPlugin(name = "Security")
public class SecurityPlugin extends Plugin {
    static final String PREFS = "docscan_security";
    static final String KEY_SECURE = "flag_secure";

    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_SECURE, enabled).apply();
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    static boolean isSecure(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_SECURE, false);
    }
}
