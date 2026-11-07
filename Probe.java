import java.net.*; import java.io.*; import java.util.*; import java.util.concurrent.*;
public class Probe {
  static String UA = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  static String go(String u, String ua) {
    try { HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
      if (ua != null) c.setRequestProperty("User-Agent", ua);
      c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml,application/json,text/csv,*/*");
      c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
      c.setConnectTimeout(12000); c.setReadTimeout(12000);
      long t = System.currentTimeMillis(); int s = c.getResponseCode();
      InputStream in = s >= 400 ? c.getErrorStream() : c.getInputStream();
      byte[] b = in == null ? new byte[0] : in.readAllBytes();
      String head = new String(b, 0, Math.min(90, b.length)).replaceAll("\\s+"," ");
      return s + " " + c.getHeaderField("Content-Type") + " len=" + b.length + " " + (System.currentTimeMillis()-t) + "ms acao=" + c.getHeaderField("Access-Control-Allow-Origin") + " srv=" + c.getHeaderField("Server") + " | " + head;
    } catch (Exception e) { return "ERR " + e; }
  }
  public static void main(String[] a) throws Exception {
    String[] uas = {"Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP2A.240805.005)", "curl/8.7.1", "Wget/1.21.4", "python-requests/2.32.3", "okhttp/4.12.0", "Java/17.0.10", "JAEconPulse/1.5", "Mozilla/5.0 (compatible; JAEconPulse/1.5)", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"};
    String[] urls = {"https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2025-11-01", "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/JAM/USA/CAN/GBR"};
    for (String ua : uas) for (String u : urls) System.out.println("UA[" + ua.substring(0, Math.min(40, ua.length())) + "] " + u.substring(8, 40) + " -> " + go(u, ua).substring(0, 120));
    String[] fred = {"DCOILBRENTEU","DHHNGSP","FEDFUNDS","DGS10","UNRATE","CPIAUCSL","UMCSENT","DTWEXBGS","PFOODINDEXM","PWHEAMTUSDM","PMAIZMTUSDM","PALUMUSDM","PCU483111483111","VIXCLS","BAMLEMHBHYCRPIOAS","SP500","DTB3","LRUNTTTTCAM156S"};
    ExecutorService ex = Executors.newFixedThreadPool(24); List<Future<String>> fs = new ArrayList<>();
    for (String f : fred) fs.add(ex.submit(() -> go("https://fred.stlouisfed.org/graph/fredgraph.csv?id="+f+"&cosd=2024-11-01", "curl/8.7.1")));
    for (int i = 0; i < fred.length; i++) System.out.println("PAR-CURL " + fred[i] + " -> " + fs.get(i).get().substring(0, 90));
    ex.shutdown();
  }
}
