package com.docscan.ocr;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Minimal IPP/1.1 + 2.0 client (RFC 8010/8011) for network printers such as
 * Toshiba e-STUDIO and Canon imageRUNNER, plus raw port-9100 (PJL + PDF).
 *
 * Pure Java (no Android APIs) so it can be unit-tested on a desktop JVM.
 *
 * Security:
 *  - Plain IPP / raw 9100 are refused unless the printer resolves to a
 *    private, link-local or loopback address (documents never leave the LAN
 *    unencrypted).
 *  - IPPS pins the printer's certificate by SHA-256 fingerprint
 *    (trust-on-first-use confirmed by the user); a changed certificate fails.
 */
public final class IppClient {
    // Operations
    public static final int PRINT_JOB = 0x0002;
    public static final int GET_JOB_ATTRIBUTES = 0x0009;
    public static final int GET_PRINTER_ATTRIBUTES = 0x000B;

    // Value tags
    static final int T_INTEGER = 0x21, T_BOOLEAN = 0x22, T_ENUM = 0x23, T_TEXT_LANG = 0x35, T_NAME_LANG = 0x36,
            T_BEG_COLLECTION = 0x34, T_END_COLLECTION = 0x37, T_TEXT = 0x41, T_NAME = 0x42, T_KEYWORD = 0x44,
            T_URI = 0x45, T_CHARSET = 0x47, T_LANGUAGE = 0x48, T_MIME = 0x49, T_MEMBER_NAME = 0x4A;

    public static final long MAX_DOCUMENT_BYTES = 200L * 1024 * 1024;

    public static final class Target {
        public String host;
        public int port = 631;
        public String path = "/ipp/print";
        public boolean tls;
        /** Hex SHA-256 of the printer certificate to require (IPPS). */
        public String pinnedSha256;
        /** Accept an unknown certificate once to read its fingerprint (connection test only). */
        public boolean trustOnFirstUse;
        public int timeoutMs = 20000;

        public String uri() {
            String h = host.contains(":") ? "[" + host + "]" : host;
            return (tls ? "ipps://" : "ipp://") + h + ":" + port + (path.startsWith("/") ? path : "/" + path);
        }
    }

    public static final class Options {
        public int copies = 1;
        public String sides = "one-sided";
        public String color = "monochrome";
        public String media = "iso_a4_210x297mm";
    }

    public static final class Response {
        public int statusCode;
        public int requestId;
        public String certSha256;
        public final Map<String, List<Object>> attrs = new LinkedHashMap<>();

        public Object first(String name) {
            List<Object> v = attrs.get(name);
            return v == null || v.isEmpty() ? null : v.get(0);
        }
    }

    /** IPP request builder. */
    public static final class Request {
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        private final DataOutputStream out = new DataOutputStream(buf);

        public Request(int operation, int requestId) throws IOException {
            out.writeShort(0x0200); // IPP 2.0 (Toshiba/Canon also accept 1.1-compatible encoding)
            out.writeShort(operation);
            out.writeInt(requestId);
        }

        public Request group(int tag) throws IOException { out.writeByte(tag); return this; }

        public Request string(int tag, String name, String value) throws IOException {
            byte[] n = name.getBytes(StandardCharsets.UTF_8), v = value.getBytes(StandardCharsets.UTF_8);
            out.writeByte(tag); out.writeShort(n.length); out.write(n); out.writeShort(v.length); out.write(v);
            return this;
        }

        /** Additional value for the previous attribute (1setOf). */
        public Request more(int tag, String value) throws IOException {
            byte[] v = value.getBytes(StandardCharsets.UTF_8);
            out.writeByte(tag); out.writeShort(0); out.writeShort(v.length); out.write(v);
            return this;
        }

        public Request integer(int tag, String name, int value) throws IOException {
            byte[] n = name.getBytes(StandardCharsets.UTF_8);
            out.writeByte(tag); out.writeShort(n.length); out.write(n); out.writeShort(4); out.writeInt(value);
            return this;
        }

        public Request bool(String name, boolean value) throws IOException {
            byte[] n = name.getBytes(StandardCharsets.UTF_8);
            out.writeByte(T_BOOLEAN); out.writeShort(n.length); out.write(n); out.writeShort(1); out.writeByte(value ? 1 : 0);
            return this;
        }

        public byte[] end() throws IOException { out.writeByte(0x03); out.flush(); return buf.toByteArray(); }
    }

    private static final SecureRandom RNG = new SecureRandom();

    private static Request base(int op, Target t, String user) throws IOException {
        Request r = new Request(op, 1 + RNG.nextInt(0x7FFFFFF0));
        r.group(0x01)
                .string(T_CHARSET, "attributes-charset", "utf-8")
                .string(T_LANGUAGE, "attributes-natural-language", "en")
                .string(T_URI, "printer-uri", t.uri());
        if (user != null) r.string(T_NAME, "requesting-user-name", clean(user, 64));
        return r;
    }

    static String clean(String s, int max) {
        String v = s.replaceAll("[\\p{Cntrl}]", " ").trim();
        return v.length() > max ? v.substring(0, max) : v;
    }

    // ── Operations ───────────────────────────────────────────────────────────

    public static Response getPrinterAttributes(Target t) throws IOException {
        Request r = base(GET_PRINTER_ATTRIBUTES, t, "DocScan");
        r.string(T_KEYWORD, "requested-attributes", "printer-make-and-model");
        for (String a : new String[] {"printer-name", "printer-info", "printer-state", "printer-state-reasons",
                "printer-is-accepting-jobs", "document-format-supported", "color-supported", "sides-supported",
                "media-supported", "media-default", "copies-supported", "print-color-mode-supported"}) {
            r.more(T_KEYWORD, a);
        }
        return send(t, r.end(), null);
    }

    public static Response printJob(Target t, File document, String format, String jobName, String user,
                                    String accountId, Options o) throws IOException {
        if (document.length() > MAX_DOCUMENT_BYTES) throw new IOException("Document too large to print");
        Request r = base(PRINT_JOB, t, user);
        r.string(T_NAME, "job-name", clean(jobName, 120))
                .bool("ipp-attribute-fidelity", false) // ignore options the printer can't honour instead of failing
                .string(T_MIME, "document-format", format);
        r.group(0x02)
                .integer(T_INTEGER, "copies", Math.max(1, Math.min(99, o.copies)))
                .string(T_KEYWORD, "sides", o.sides)
                .string(T_KEYWORD, "print-color-mode", o.color)
                .string(T_KEYWORD, "media", o.media);
        if (format.startsWith("image/")) r.string(T_KEYWORD, "print-scaling", "fit");
        if (accountId != null && !accountId.isEmpty()) r.string(T_NAME, "job-account-id", clean(accountId, 64));
        return send(t, r.end(), document);
    }

    public static Response getJobAttributes(Target t, int jobId, String user) throws IOException {
        Request r = base(GET_JOB_ATTRIBUTES, t, null);
        r.integer(T_INTEGER, "job-id", jobId);
        r.string(T_NAME, "requesting-user-name", clean(user, 64));
        r.string(T_KEYWORD, "requested-attributes", "job-state").more(T_KEYWORD, "job-state-reasons");
        return send(t, r.end(), null);
    }

    /** Raw port 9100: PJL job header + PDF (Toshiba/Canon "PDF direct print"). */
    public static void rawPrint(String host, int port, File document, String jobName, String user, Options o, int timeoutMs) throws IOException {
        requireLan(host);
        if (document.length() > MAX_DOCUMENT_BYTES) throw new IOException("Document too large to print");
        String uel = "\u001B%-12345X";
        String name = clean(jobName, 60).replace("\"", "'");
        StringBuilder pjl = new StringBuilder(uel).append("@PJL\r\n")
                .append("@PJL JOB NAME=\"").append(name).append("\"\r\n")
                .append("@PJL SET USERNAME=\"").append(clean(user, 40).replace("\"", "'")).append("\"\r\n")
                .append("@PJL SET COPIES=").append(Math.max(1, Math.min(99, o.copies))).append("\r\n")
                .append("@PJL SET DUPLEX=").append(o.sides.startsWith("two-sided") ? "ON" : "OFF").append("\r\n");
        if (o.sides.startsWith("two-sided"))
            pjl.append("@PJL SET BINDING=").append(o.sides.endsWith("short-edge") ? "SHORTEDGE" : "LONGEDGE").append("\r\n");
        pjl.append("@PJL SET RENDERMODE=").append("color".equals(o.color) ? "COLOR" : "GRAYSCALE").append("\r\n")
                .append("@PJL SET PAPER=").append(o.media.contains("a3") ? "A3" : o.media.contains("letter") ? "LETTER"
                        : o.media.contains("legal") ? "LEGAL" : "A4").append("\r\n")
                .append("@PJL ENTER LANGUAGE=PDF\r\n");
        String trailer = uel + "@PJL EOJ NAME=\"" + name + "\"\r\n" + uel;
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            OutputStream out = s.getOutputStream();
            out.write(pjl.toString().getBytes(StandardCharsets.US_ASCII));
            try (InputStream in = new FileInputStream(document)) { copy(in, out); }
            out.write(trailer.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            s.shutdownOutput();
        }
    }

    // ── Transport: HTTP/1.1 over a plain or pinned-TLS socket ────────────────

    static Response send(Target t, byte[] ippHeader, File document) throws IOException {
        if (!t.tls) requireLan(t.host);
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(t.host, t.port), t.timeoutMs);
        raw.setSoTimeout(t.timeoutMs);
        Socket s = raw;
        String[] certHash = new String[1];
        if (t.tls) {
            try {
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[] {new PinningTrustManager(t.pinnedSha256, t.trustOnFirstUse, certHash)}, RNG);
                SSLSocket ssl = (SSLSocket) ctx.getSocketFactory().createSocket(raw, t.host, t.port, true);
                ssl.setEnabledProtocols(filterProtocols(ssl.getSupportedProtocols()));
                ssl.startHandshake();
                s = ssl;
            } catch (IOException e) {
                raw.close();
                throw e;
            } catch (Exception e) {
                raw.close();
                throw new IOException("Secure connection failed: " + e.getMessage(), e);
            }
        }
        try (Socket sock = s) {
            long len = ippHeader.length + (document == null ? 0 : document.length());
            String hostHeader = (t.host.contains(":") ? "[" + t.host + "]" : t.host) + ":" + t.port;
            String head = "POST " + (t.path.startsWith("/") ? t.path : "/" + t.path) + " HTTP/1.1\r\n"
                    + "Host: " + hostHeader + "\r\n"
                    + "Content-Type: application/ipp\r\n"
                    + "Content-Length: " + len + "\r\n"
                    + "User-Agent: DocScan-IPP/1.0\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = sock.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(ippHeader);
            if (document != null) try (InputStream in = new FileInputStream(document)) { copy(in, out); }
            out.flush();
            Response r = parseHttp(new BufferedInputStream(sock.getInputStream()));
            r.certSha256 = certHash[0];
            return r;
        }
    }

    static String[] filterProtocols(String[] supported) {
        List<String> ok = new ArrayList<>();
        for (String p : supported) if (p.equals("TLSv1.2") || p.equals("TLSv1.3")) ok.add(p);
        if (ok.isEmpty()) throw new IllegalStateException("TLS 1.2+ not available");
        return ok.toArray(new String[0]);
    }

    static Response parseHttp(InputStream in) throws IOException {
        int status;
        Map<String, String> headers;
        do {
            String statusLine = readLine(in);
            if (statusLine == null || !statusLine.startsWith("HTTP/")) throw new IOException("Printer sent an invalid response");
            String[] parts = statusLine.split(" ", 3);
            status = Integer.parseInt(parts[1]);
            headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
        } while (status == 100);
        if (status == 401) throw new IOException("The printer requires a password (HTTP 401)");
        if (status == 404) throw new IOException("Print queue not found — check the queue path");
        if (status != 200) throw new IOException("Printer returned HTTP " + status);
        byte[] body;
        if ("chunked".equalsIgnoreCase(headers.get("transfer-encoding"))) body = readChunked(in);
        else if (headers.containsKey("content-length")) body = readN(in, Integer.parseInt(headers.get("content-length")));
        else body = readAll(in);
        return decode(body);
    }

    /** Decode an IPP response body. Collections are skipped. */
    public static Response decode(byte[] body) throws IOException {
        DataInputStream in = new DataInputStream(new java.io.ByteArrayInputStream(body));
        Response r = new Response();
        in.readUnsignedShort(); // version
        r.statusCode = in.readUnsignedShort();
        r.requestId = in.readInt();
        String last = null;
        int depth = 0;
        while (in.available() > 0) {
            int tag = in.readUnsignedByte();
            if (tag == 0x03) break;
            if (tag <= 0x0F) continue; // group delimiter
            int nl = in.readUnsignedShort();
            String name = nl > 0 ? new String(readN(in, nl), StandardCharsets.UTF_8) : null;
            int vl = in.readUnsignedShort();
            byte[] v = readN(in, vl);
            if (tag == T_BEG_COLLECTION) { depth++; if (name != null) last = null; continue; }
            if (tag == T_END_COLLECTION) { depth = Math.max(0, depth - 1); continue; }
            if (depth > 0 || tag == T_MEMBER_NAME) continue;
            if (name != null) last = name;
            if (last == null) continue;
            Object value;
            if ((tag == T_INTEGER || tag == T_ENUM) && vl == 4) value = ((v[0] & 0xFF) << 24) | ((v[1] & 0xFF) << 16) | ((v[2] & 0xFF) << 8) | (v[3] & 0xFF);
            else if (tag == T_BOOLEAN && vl == 1) value = v[0] != 0;
            else if (tag == T_TEXT_LANG || tag == T_NAME_LANG) {
                int ll = ((v[0] & 0xFF) << 8) | (v[1] & 0xFF);
                int tl = ((v[2 + ll] & 0xFF) << 8) | (v[3 + ll] & 0xFF);
                value = new String(v, 4 + ll, tl, StandardCharsets.UTF_8);
            } else if (tag >= 0x40 && tag <= 0x4F) value = new String(v, StandardCharsets.UTF_8);
            else continue; // dates, resolutions, ranges, octet strings: not needed
            r.attrs.computeIfAbsent(last, k -> new ArrayList<>()).add(value);
        }
        return r;
    }

    // ── Network safety ───────────────────────────────────────────────────────

    /** Refuse unencrypted printing to anything outside the local network. */
    static void requireLan(String host) throws IOException {
        InetAddress[] addrs = InetAddress.getAllByName(host);
        for (InetAddress a : addrs) {
            boolean ula = a instanceof Inet6Address && (a.getAddress()[0] & 0xFE) == 0xFC; // fc00::/7
            if (!(a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isLoopbackAddress() || ula)) {
                throw new IOException("For security, unencrypted printing is only allowed to printers on your local network. Use IPPS for " + host);
            }
        }
    }

    static final class PinningTrustManager implements X509TrustManager {
        private final String pin;
        private final boolean tofu;
        private final String[] seen;

        PinningTrustManager(String pin, boolean tofu, String[] seen) { this.pin = pin; this.tofu = tofu; this.seen = seen; }

        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("Client certificates not supported");
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("No printer certificate");
            String fp = sha256Hex(chain[0].getEncoded());
            seen[0] = fp;
            if (pin != null && !pin.isEmpty()) {
                if (!pin.equalsIgnoreCase(fp)) throw new CertificateException("The printer's certificate has changed. If this is expected, test the connection again to re-trust it.");
                return;
            }
            if (!tofu) throw new CertificateException("Printer certificate not trusted yet — run Test connection first");
            chain[0].checkValidity();
        }

        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    static String sha256Hex(byte[] data) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── IO helpers ───────────────────────────────────────────────────────────

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] b = new byte[64 * 1024];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
    }

    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Header line too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("ISO-8859-1");
    }

    static byte[] readN(InputStream in, int n) throws IOException {
        if (n < 0 || n > 16 * 1024 * 1024) throw new IOException("Invalid length");
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) throw new IOException("Truncated response");
            off += r;
        }
        return b;
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        copy(in, b);
        return b.toByteArray();
    }

    static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        while (true) {
            String line = readLine(in);
            if (line == null) break;
            int size = Integer.parseInt(line.split(";")[0].trim(), 16);
            if (size == 0) { readLine(in); break; }
            b.write(readN(in, size));
            readLine(in);
        }
        return b.toByteArray();
    }
}
