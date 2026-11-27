package com.docscan.ocr;

import android.content.Context;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Printing for DocScan:
 *  - printPdf: Android print framework (Mopria, Canon PRINT Service, Toshiba e-BRIDGE plug-ins…)
 *  - discover: finds IPP/IPPS printers on the local network via DNS-SD (mDNS)
 *  - getAttributes / printJob / jobStatus: direct IPP / IPPS (see IppClient)
 *  - rawPrint: port 9100 PJL + PDF
 */
@CapacitorPlugin(name = "Printer")
public class PrinterPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // ── System print dialog ──────────────────────────────────────────────────
    @PluginMethod
    public void printPdf(PluginCall call) {
        File file = fileOf(call.getString("path"));
        String name = call.getString("name", "DocScan document");
        if (file == null || !file.exists()) { call.reject("Document not found"); return; }
        PrintAttributes.Builder attrs = new PrintAttributes.Builder();
        String media = call.getString("media", "");
        if (media.contains("a3")) attrs.setMediaSize(PrintAttributes.MediaSize.ISO_A3);
        else if (media.contains("letter")) attrs.setMediaSize(PrintAttributes.MediaSize.NA_LETTER);
        else if (media.contains("legal")) attrs.setMediaSize(PrintAttributes.MediaSize.NA_LEGAL);
        else attrs.setMediaSize(PrintAttributes.MediaSize.ISO_A4);
        attrs.setColorMode("color".equals(call.getString("color")) ? PrintAttributes.COLOR_MODE_COLOR : PrintAttributes.COLOR_MODE_MONOCHROME);
        String sides = call.getString("duplex", "one-sided");
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            attrs.setDuplexMode(sides.endsWith("long-edge") ? PrintAttributes.DUPLEX_MODE_LONG_EDGE
                    : sides.endsWith("short-edge") ? PrintAttributes.DUPLEX_MODE_SHORT_EDGE : PrintAttributes.DUPLEX_MODE_NONE);
        }
        getActivity().runOnUiThread(() -> {
            PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            pm.print(name, new PdfAdapter(file, name), attrs.build());
            call.resolve();
        });
    }

    static final class PdfAdapter extends PrintDocumentAdapter {
        private final File file;
        private final String name;

        PdfAdapter(File file, String name) { this.file = file; this.name = name; }

        @Override
        public void onLayout(PrintAttributes oldAttrs, PrintAttributes newAttrs, CancellationSignal cancel,
                             LayoutResultCallback cb, Bundle extras) {
            if (cancel.isCanceled()) { cb.onLayoutCancelled(); return; }
            cb.onLayoutFinished(new PrintDocumentInfo.Builder(name.replaceAll("[^A-Za-z0-9._ -]", "_") + ".pdf")
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN).build(), true);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor dest, CancellationSignal cancel, WriteResultCallback cb) {
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(dest.getFileDescriptor())) {
                byte[] b = new byte[64 * 1024];
                int n;
                while ((n = in.read(b)) > 0) {
                    if (cancel.isCanceled()) { cb.onWriteCancelled(); return; }
                    out.write(b, 0, n);
                }
                cb.onWriteFinished(new PageRange[] {PageRange.ALL_PAGES});
            } catch (Exception e) {
                cb.onWriteFailed(e.getMessage());
            }
        }
    }

    // ── Discovery (DNS-SD) ───────────────────────────────────────────────────
    @PluginMethod
    public void discover(PluginCall call) {
        int timeout = Math.max(2000, Math.min(15000, call.getInt("timeoutMs", 5000)));
        NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        List<JSObject> found = new ArrayList<>();
        Deque<NsdServiceInfo> pending = new ArrayDeque<>();
        boolean[] resolving = {false};
        Handler main = new Handler(Looper.getMainLooper());
        List<NsdManager.DiscoveryListener> listeners = new ArrayList<>();

        Runnable[] next = new Runnable[1];
        next[0] = () -> {
            if (resolving[0] || pending.isEmpty()) return;
            resolving[0] = true;
            NsdServiceInfo info = pending.poll();
            //noinspection deprecation — resolveService is fine for one-at-a-time resolution
            nsd.resolveService(info, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo s, int err) { resolving[0] = false; main.post(next[0]); }
                @Override public void onServiceResolved(NsdServiceInfo s) {
                    synchronized (found) { found.add(describe(s)); }
                    resolving[0] = false;
                    main.post(next[0]);
                }
            });
        };

        for (String type : new String[] {"_ipps._tcp", "_ipp._tcp"}) {
            NsdManager.DiscoveryListener l = new NsdManager.DiscoveryListener() {
                @Override public void onStartDiscoveryFailed(String t, int e) {}
                @Override public void onStopDiscoveryFailed(String t, int e) {}
                @Override public void onDiscoveryStarted(String t) {}
                @Override public void onDiscoveryStopped(String t) {}
                @Override public void onServiceLost(NsdServiceInfo s) {}
                @Override public void onServiceFound(NsdServiceInfo s) { main.post(() -> { pending.add(s); next[0].run(); }); }
            };
            listeners.add(l);
            try { nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l); } catch (Exception ignored) {}
        }
        main.postDelayed(() -> {
            for (NsdManager.DiscoveryListener l : listeners) { try { nsd.stopServiceDiscovery(l); } catch (Exception ignored) {} }
            JSArray arr = new JSArray();
            synchronized (found) {
                // Prefer the IPPS record when a printer advertises both.
                List<String> seen = new ArrayList<>();
                for (JSObject o : found) if (o.optBoolean("tls")) { seen.add(o.optString("host")); arr.put(o); }
                for (JSObject o : found) if (!o.optBoolean("tls") && !seen.contains(o.optString("host"))) arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("printers", arr);
            call.resolve(ret);
        }, timeout);
    }

    private static JSObject describe(NsdServiceInfo s) {
        JSObject o = new JSObject();
        Map<String, byte[]> txt = s.getAttributes();
        String rp = txt(txt, "rp");
        o.put("name", s.getServiceName());
        o.put("host", s.getHost() != null ? s.getHost().getHostAddress() : "");
        o.put("port", s.getPort());
        o.put("tls", s.getServiceType().contains("ipps"));
        o.put("path", rp == null || rp.isEmpty() ? "" : "/" + rp);
        o.put("model", txt(txt, "ty"));
        o.put("pdl", txt(txt, "pdl"));
        o.put("color", "T".equalsIgnoreCase(txt(txt, "Color")));
        o.put("duplex", "T".equalsIgnoreCase(txt(txt, "Duplex")));
        return o;
    }

    private static String txt(Map<String, byte[]> m, String k) {
        byte[] v = m.get(k);
        return v == null ? null : new String(v, StandardCharsets.UTF_8);
    }

    // ── Direct IPP ───────────────────────────────────────────────────────────
    private IppClient.Target target(PluginCall call) {
        IppClient.Target t = new IppClient.Target();
        t.host = call.getString("host");
        t.port = call.getInt("port", 631);
        t.path = call.getString("path", "/ipp/print");
        t.tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        t.pinnedSha256 = call.getString("pinnedSha256");
        t.trustOnFirstUse = Boolean.TRUE.equals(call.getBoolean("trustOnFirstUse", false));
        return t;
    }

    private static IppClient.Options options(JSObject o) {
        IppClient.Options r = new IppClient.Options();
        if (o == null) return r;
        r.copies = o.optInt("copies", 1);
        r.sides = o.optString("sides", "one-sided");
        r.color = o.optString("color", "monochrome");
        r.media = o.optString("media", "iso_a4_210x297mm");
        return r;
    }

    private static JSObject toJs(IppClient.Response r) {
        JSObject o = new JSObject();
        o.put("statusCode", r.statusCode);
        if (r.certSha256 != null) o.put("certSha256", r.certSha256);
        JSObject attrs = new JSObject();
        for (Map.Entry<String, List<Object>> e : r.attrs.entrySet()) {
            JSArray a = new JSArray();
            for (Object v : e.getValue()) a.put(v);
            attrs.put(e.getKey(), a);
        }
        o.put("attrs", attrs);
        return o;
    }

    @PluginMethod
    public void getAttributes(PluginCall call) {
        io.execute(() -> {
            try { call.resolve(toJs(IppClient.getPrinterAttributes(target(call)))); }
            catch (Exception e) { call.reject(friendly(e)); }
        });
    }

    @PluginMethod
    public void printJob(PluginCall call) {
        File file = fileOf(call.getString("filePath"));
        if (file == null || !file.exists()) { call.reject("Document not found"); return; }
        io.execute(() -> {
            try {
                IppClient.Response r = IppClient.printJob(target(call), file, call.getString("format", "application/pdf"),
                        call.getString("jobName", "DocScan"), call.getString("user", "DocScan"), call.getString("accountId"),
                        options(call.getObject("options")));
                JSObject o = new JSObject();
                o.put("statusCode", r.statusCode);
                Object id = r.first("job-id");
                if (id != null) o.put("jobId", id);
                Object st = r.first("job-state");
                if (st != null) o.put("jobState", st);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(friendly(e));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    @PluginMethod
    public void jobStatus(PluginCall call) {
        io.execute(() -> {
            try {
                IppClient.Response r = IppClient.getJobAttributes(target(call), call.getInt("jobId", 0), call.getString("user", "DocScan"));
                JSObject o = new JSObject();
                Object st = r.first("job-state");
                o.put("jobState", st == null ? 0 : st);
                JSArray reasons = new JSArray();
                List<Object> rs = r.attrs.get("job-state-reasons");
                if (rs != null) for (Object x : rs) reasons.put(x);
                o.put("reasons", reasons);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(friendly(e));
            }
        });
    }

    @PluginMethod
    public void rawPrint(PluginCall call) {
        File file = fileOf(call.getString("filePath"));
        if (file == null || !file.exists()) { call.reject("Document not found"); return; }
        io.execute(() -> {
            try {
                IppClient.rawPrint(call.getString("host"), call.getInt("port", 9100), file, call.getString("jobName", "DocScan"),
                        call.getString("user", "DocScan"), options(call.getObject("options")), 20000);
                call.resolve();
            } catch (Exception e) {
                call.reject(friendly(e));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    private static String friendly(Exception e) {
        String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        if (e instanceof java.net.ConnectException || m.contains("ECONNREFUSED")) return "The printer refused the connection — check the IP address, port and that IPP is enabled";
        if (e instanceof java.net.SocketTimeoutException) return "The printer did not respond — check it is on and on the same network";
        if (e instanceof java.net.UnknownHostException) return "Printer address not found";
        return m;
    }

    private File fileOf(String path) {
        if (path == null) return null;
        String p = path.startsWith("file:") ? Uri.parse(path).getPath() : path;
        if (p == null) return null;
        File f = new File(p);
        // Only files inside the app's own storage may be printed.
        try {
            String canon = f.getCanonicalPath();
            String cache = getContext().getCacheDir().getCanonicalPath();
            String files = getContext().getFilesDir().getCanonicalPath();
            if (!canon.startsWith(cache) && !canon.startsWith(files)) return null;
        } catch (Exception e) {
            return null;
        }
        return f;
    }
}
