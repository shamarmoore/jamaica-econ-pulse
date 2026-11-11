import java.net.*; import java.io.*;
public class Probe {
  static String UA = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  static String go(String u) {
    try { HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
      c.setRequestProperty("User-Agent", UA); c.setRequestProperty("Accept", "application/json,application/atom+xml,text/xml,*/*"); c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
      c.setConnectTimeout(20000); c.setReadTimeout(20000); long t = System.currentTimeMillis(); int s = c.getResponseCode();
      InputStream in = s >= 400 ? c.getErrorStream() : c.getInputStream(); byte[] b = in == null ? new byte[0] : in.readAllBytes();
      return s + " " + c.getHeaderField("Content-Type") + " len=" + b.length + " " + (System.currentTimeMillis() - t) + "ms | " + new String(b, 0, Math.min(400, b.length)).replaceAll("\\s+", " ");
    } catch (Exception e) { return "ERR " + e; }
  }
  public static void main(String[] a) {
    String[] urls = {
      "https://export.arxiv.org/api/query?search_query=" + URLEncoder.encode("ti:forecasting AND (abs:\"time series\" OR abs:demand) AND (cat:cs.LG OR cat:stat.ML OR cat:cs.AI)", java.nio.charset.StandardCharsets.UTF_8) + "&sortBy=submittedDate&sortOrder=descending&max_results=3",
      "https://api.openalex.org/works?search=" + URLEncoder.encode("logistics management", java.nio.charset.StandardCharsets.UTF_8) + "&filter=from_publication_date:2025-11-01,type:article&per-page=3&select=id,display_name,publication_date,cited_by_count,open_access,primary_location,authorships,abstract_inverted_index,doi",
      "https://api.openalex.org/works?search=" + URLEncoder.encode("sales innovation", java.nio.charset.StandardCharsets.UTF_8) + "&filter=from_publication_date:2024-11-01&per-page=3&select=id,display_name,publication_date,cited_by_count",
      "https://api.semanticscholar.org/graph/v1/paper/search?query=" + URLEncoder.encode("sales forecasting machine learning", java.nio.charset.StandardCharsets.UTF_8) + "&limit=3&fields=title,year,citationCount,openAccessPdf",
    };
    for (String u : urls) System.out.println("RES " + u.substring(8, 60) + " -> " + go(u));
  }
}
