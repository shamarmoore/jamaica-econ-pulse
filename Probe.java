import java.net.*; import java.io.*; import java.util.*; import java.util.concurrent.*;
public class Probe {
  static String UA = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  static String go(String u, String ua) {
    try { HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
      if (ua != null) c.setRequestProperty("User-Agent", ua);
      c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml,application/json,text/csv,*/*");
      c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
      c.setConnectTimeout(25000); c.setReadTimeout(25000);
      long t = System.currentTimeMillis(); int s = c.getResponseCode();
      InputStream in = s >= 400 ? c.getErrorStream() : c.getInputStream();
      byte[] b = in == null ? new byte[0] : in.readAllBytes();
      String head = new String(b, 0, Math.min(90, b.length)).replaceAll("\\s+"," ");
      return s + " " + c.getHeaderField("Content-Type") + " len=" + b.length + " " + (System.currentTimeMillis()-t) + "ms acao=" + c.getHeaderField("Access-Control-Allow-Origin") + " srv=" + c.getHeaderField("Server") + " | " + head;
    } catch (Exception e) { return "ERR " + e; }
  }
  public static void main(String[] a) throws Exception {
    String[] fred = {"DCOILBRENTEU","DHHNGSP","FEDFUNDS","DGS10","UNRATE","CPIAUCSL","UMCSENT","DTWEXBGS","PFOODINDEXM","PWHEAMTUSDM","PMAIZMTUSDM","PALUMUSDM","PCU483111483111","VIXCLS","BAMLEMHBHYCRPIOAS","SP500","DTB3","LRUNTTTTCAM156S"};
    String[] imf = {"NGDP_RPCH","PCPIPCH","GGXWDG_NGDP","BCA_NGDPD","LUR","NGDPD"};
    List<String> urls = new ArrayList<>();
    for (String f : fred) urls.add("https://fred.stlouisfed.org/graph/fredgraph.csv?id="+f+"&cosd=2024-11-01");
    for (String i : imf) urls.add("https://www.imf.org/external/datamapper/api/v1/"+i+"/JAM/USA/CAN/GBR");
    ExecutorService ex = Executors.newFixedThreadPool(24);
    List<Future<String>> fs = new ArrayList<>();
    for (String u : urls) fs.add(ex.submit(() -> go(u, UA)));
    for (int i = 0; i < urls.size(); i++) System.out.println("PAR " + urls.get(i).replaceAll("https://","").substring(0, Math.min(70, urls.get(i).length()-8)) + " -> " + fs.get(i).get());
    String[] extra = {
      "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU",
      "https://fred.stlouisfed.org/data/DCOILBRENTEU.txt",
      "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/JAM",
      "https://api.db.nomics.world/v22/series/IMF/WEO:latest/JAM.NGDP_RPCH.pcent_change?observations=1",
      "https://api.db.nomics.world/v22/series/IMF/WEO:latest?dimensions=%7B%22weo-country%22%3A%5B%22JAM%22%5D%7D&limit=5",
    };
    for (String u : extra) { System.out.println("CHROMEUA " + u + " -> " + go(u, UA)); System.out.println("JAVAUA   " + u + " -> " + go(u, null)); System.out.println("APPUA    " + u + " -> " + go(u, "JAEconPulse/1.4 (Android)")); }
    ex.shutdown();
  }
}
