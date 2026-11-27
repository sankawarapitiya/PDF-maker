import com.docscan.ocr.IppClient;
import java.io.File;
import java.io.IOException;

/** Driven by tests/ipp-client.test.mjs against tests/fake-printer.mjs. */
public class IppClientTest {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); System.out.println("ok - " + msg); }

    static IppClient.Target target(int port, boolean tls) {
        IppClient.Target t = new IppClient.Target();
        t.host = "127.0.0.1"; t.port = port; t.path = "/Print"; t.tls = tls; t.timeoutMs = 5000;
        return t;
    }

    public static void main(String[] a) throws Exception {
        int ipp = Integer.parseInt(a[0]), ipps = Integer.parseInt(a[1]), raw = Integer.parseInt(a[2]);
        File pdf = new File(a[3]);

        // Plain IPP on loopback (LAN) is allowed
        IppClient.Response info = IppClient.getPrinterAttributes(target(ipp, false));
        check(info.statusCode == 0, "get-printer-attributes ok");
        check("TOSHIBA e-STUDIO3015AC".equals(info.first("printer-make-and-model")), "model decoded");
        check(info.attrs.get("document-format-supported").contains("application/pdf"), "formats decoded");
        check(Integer.valueOf(3).equals(info.first("printer-state")), "state enum decoded");
        check(Boolean.TRUE.equals(info.first("color-supported")), "boolean decoded");

        IppClient.Options o = new IppClient.Options();
        o.copies = 2; o.sides = "two-sided-long-edge"; o.color = "color"; o.media = "iso_a3_297x420mm";
        IppClient.Response job = IppClient.printJob(target(ipp, false), pdf, "application/pdf", "Invoice 2048", "alice", "DEPT-42", o);
        check(job.statusCode == 0, "print-job accepted");
        int jobId = (Integer) job.first("job-id");
        check(jobId == 101, "job-id returned");
        IppClient.Response st = IppClient.getJobAttributes(target(ipp, false), jobId, "alice");
        check(Integer.valueOf(9).equals(st.first("job-state")), "job completed");

        IppClient.Response bad = IppClient.printJob(target(ipp, false), pdf, "application/x-unknown", "x", "alice", null, o);
        check(bad.statusCode == 0x040A, "unsupported format status returned");

        // Unencrypted printing to a public address is refused before connecting
        IppClient.Target pub = target(631, false); pub.host = "8.8.8.8";
        try { IppClient.getPrinterAttributes(pub); check(false, "public plain IPP refused"); }
        catch (IOException e) { check(e.getMessage().contains("local network"), "public plain IPP refused"); }

        // IPPS: unknown certificate refused without trust-on-first-use
        try { IppClient.getPrinterAttributes(target(ipps, true)); check(false, "untrusted cert refused"); }
        catch (IOException e) { check(true, "untrusted cert refused"); }
        IppClient.Target tofu = target(ipps, true); tofu.trustOnFirstUse = true;
        IppClient.Response first = IppClient.getPrinterAttributes(tofu);
        check(first.certSha256 != null && first.certSha256.length() == 64, "certificate fingerprint captured");
        IppClient.Target pinned = target(ipps, true); pinned.pinnedSha256 = first.certSha256;
        check(IppClient.printJob(pinned, pdf, "application/pdf", "Secure", "alice", null, o).statusCode == 0, "ipps print with pinned cert");
        IppClient.Target wrong = target(ipps, true); wrong.pinnedSha256 = "00".repeat(32);
        try { IppClient.getPrinterAttributes(wrong); check(false, "changed cert refused"); }
        catch (IOException e) { check(true, "changed cert refused"); }

        // Raw 9100 with PJL header
        IppClient.rawPrint("127.0.0.1", raw, pdf, "Raw job", "alice", o, 5000);
        check(true, "raw print sent");
        System.out.println("ALL JAVA IPP TESTS PASSED");
    }
}
