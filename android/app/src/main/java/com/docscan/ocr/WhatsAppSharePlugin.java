package com.docscan.ocr;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.ArrayList;

/**
 * Sends files and/or text straight to WhatsApp (or WhatsApp Business),
 * skipping the generic share sheet.
 */
@CapacitorPlugin(name = "WhatsAppShare")
public class WhatsAppSharePlugin extends Plugin {
    private static final String WHATSAPP = "com.whatsapp";
    private static final String BUSINESS = "com.whatsapp.w4b";

    private boolean installed(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("whatsapp", installed(WHATSAPP));
        ret.put("business", installed(BUSINESS));
        call.resolve(ret);
    }

    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text", null);
        String mime = call.getString("mimeType", "*/*");
        String phone = call.getString("phone", null);
        boolean preferBusiness = Boolean.TRUE.equals(call.getBoolean("business", false));
        JSArray files = call.getArray("files", new JSArray());

        String pkg = preferBusiness && installed(BUSINESS) ? BUSINESS
                : installed(WHATSAPP) ? WHATSAPP
                : installed(BUSINESS) ? BUSINESS : null;
        if (pkg == null) {
            call.reject("WhatsApp is not installed", "NOT_INSTALLED");
            return;
        }

        ArrayList<Uri> uris = new ArrayList<>();
        try {
            for (int i = 0; i < files.length(); i++) {
                String path = files.getString(i);
                File f = new File(Uri.parse(path).getPath());
                uris.add(FileProvider.getUriForFile(getContext(),
                        getContext().getPackageName() + ".fileprovider", f));
            }
        } catch (Exception e) {
            call.reject("Could not prepare file: " + e.getMessage());
            return;
        }

        Intent intent;
        if (uris.size() > 1) {
            intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
            intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            intent.setType(mime);
        } else if (uris.size() == 1) {
            intent = new Intent(Intent.ACTION_SEND);
            intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            intent.setType(mime);
        } else {
            intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain");
        }
        if (text != null) intent.putExtra(Intent.EXTRA_TEXT, text);
        if (phone != null && !phone.isEmpty()) {
            // Opens the chat with this number directly (digits incl. country code).
            intent.putExtra("jid", phone.replaceAll("[^0-9]", "") + "@s.whatsapp.net");
        }
        intent.setPackage(pkg);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("app", pkg);
            call.resolve(ret);
        } catch (ActivityNotFoundException e) {
            call.reject("WhatsApp is not installed", "NOT_INSTALLED");
        }
    }
}
