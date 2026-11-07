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
    String[] urls = {
      "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&file_type=json",
      "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&file_type=json&api_key=abcdefghijklmnopqrstuvwxyz123456",
      "https://api.imf.org/external/sdmx/2.1/data/IMF.RES,WEO/JAM.NGDP_RPCH.A?startPeriod=2020",
      "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/JAM.NGDP_RPCH.A",
      "https://sdmxcentral.imf.org/ws/public/sdmxapi/rest/data/WEO/JAM.NGDP_RPCH",
    };
    for (String u : urls) System.out.println("APPUA " + u + " -> " + go(u, UA));
  }
}
