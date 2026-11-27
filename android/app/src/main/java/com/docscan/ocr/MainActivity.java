package com.docscan.ocr;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WhatsAppSharePlugin.class);
        registerPlugin(SecurityPlugin.class);
        super.onCreate(savedInstanceState);
        // Apply "block screenshots" before any content is drawn.
        if (SecurityPlugin.isSecure(this)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }
}
