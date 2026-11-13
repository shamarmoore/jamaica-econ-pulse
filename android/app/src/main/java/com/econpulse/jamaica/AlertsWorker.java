package com.econpulse.jamaica;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Background check (about every 6 hours, when online): reads the nightly alerts file from the user's private GitHub repo
 * and compares it with the positions saved on this phone. Posts a notification for sell signals, 3-month reviews that are
 * due, dividend buy-by dates, new "strong numbers, quiet price" setups and announcements on stocks the user holds.
 * Every rule comes from the back-tests; nothing here is written by an AI. Each alert is shown once.
 */
public class AlertsWorker extends Worker {
    static final String PREFS = "alerts";
    static final String CHANNEL = "jse_alerts";
    private static final int MAX_PER_RUN = 8;

    public AlertsWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

    @NonNull
    @Override
    public Result doWork() {
        try { run(getApplicationContext()); } catch (Throwable e) { note(getApplicationContext(), "error: " + e.getMessage()); }
        return Result.success();
    }

    private static void note(Context ctx, String result) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("lastRun", System.currentTimeMillis()).putString("lastResult", result).apply();
    }

    private static JSONObject fetch(String repo, String token) throws Exception {
        URL u = new URL("https://api.github.com/repos/" + repo + "/contents/data/alerts.json?ref=main");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/vnd.github.raw+json");
            c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            c.setRequestProperty("User-Agent", "ja-econ-pulse-android");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("GitHub answered HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONObject(out.toString("UTF-8"));
        } finally { c.disconnect(); }
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "JSE alerts", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Sell signals, review dates, dividend buy-by dates and new setups");
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @SuppressLint("MissingPermission")
    static boolean post(Context ctx, String id, String title, String body) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return false;
        ensureChannel(ctx);
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = open == null ? null : PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pulse)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        if (pi != null) b.setContentIntent(pi);
        try { nm.notify(id.hashCode(), b.build()); return true; } catch (SecurityException e) { return false; }
    }

    /** One check. Returns a short plain-English result that the app shows under Sources → Notifications. */
    static synchronized String run(Context ctx) throws Exception {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", false)) return "off";
        JSONObject cfg = new JSONObject(sp.getString("config", "{}"));
        JSONArray pos = cfg.optJSONArray("positions");
        if (pos == null) pos = new JSONArray();
        boolean kSell = cfg.optBoolean("sell", true), kReview = cfg.optBoolean("review", true), kDiv = cfg.optBoolean("dividend", true),
            kSetup = cfg.optBoolean("setup", true), kNews = cfg.optBoolean("news", true);
        JSONArray seenArr = new JSONArray(sp.getString("seen", "[]"));
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < seenArr.length(); i++) seen.add(seenArr.optString(i));
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());

        JSONObject A = null;
        String err = null;
        String token = cfg.optString("token", "");
        if (token.isEmpty()) err = "no GitHub token saved";
        else {
            try { A = fetch(cfg.optString("repo", ""), token); } catch (Exception e) { err = String.valueOf(e.getMessage()); }
        }
        JSONObject ranks = A == null ? null : A.optJSONObject("ranks");
        JSONObject weak = A == null ? null : A.optJSONObject("weak");
        Set<String> suspended = new HashSet<>();
        JSONArray su = A == null ? null : A.optJSONArray("suspended");
        if (su != null) for (int i = 0; i < su.length(); i++) suspended.add(su.optString(i));

        List<String[]> out = new ArrayList<>();   // {id, title, body}
        Set<String> held = new HashSet<>();
        for (int i = 0; i < pos.length(); i++) {
            JSONObject p = pos.optJSONObject(i);
            if (p == null) continue;
            String sym = p.optString("sym"), review = p.optString("review"), pid = p.optString("id");
            held.add(sym);
            int rank = ranks == null ? 0 : ranks.optInt(sym, 0);
            boolean due = !review.isEmpty() && review.compareTo(today) <= 0;
            if (kSell && A != null) {
                JSONObject w = weak == null ? null : weak.optJSONObject(sym);
                if (w != null) out.add(new String[]{w.optString("id"), w.optString("title"), w.optString("body")});
                if (suspended.contains(sym)) out.add(new String[]{"susp-" + sym + "-" + today.substring(0, 7), sym + ": trading suspended", "You can’t buy or sell it until the suspension lifts. Check the notice in the app."});
                if (rank > 20 && !due) out.add(new String[]{"drop-" + pid + "-" + review, sym + " slipped to Edge #" + rank,
                    "It’s outside the top 20. The tested rule is not to sell early: decide at the 3-month review on " + review + "."});
            }
            if (kReview && due) {
                String body = rank == 0 ? "Open the app to see its Edge rank, then keep or sell."
                    : rank <= 20 ? "Still Edge #" + rank + " (top 20). Tested rule: keep it another 3 months, then tap “Reviewed — keep”."
                    : "Now Edge #" + rank + ", outside the top 20. Tested rule: sell and move the money to the buy list.";
                out.add(new String[]{"review-" + pid + "-" + review, "3-month review due: " + sym, body});
            }
        }
        Set<String> setupSyms = new HashSet<>();
        if (A != null) {
            JSONArray ev = A.optJSONArray("events");
            if (kDiv && ev != null) for (int i = 0; i < ev.length(); i++) {
                JSONObject e = ev.optJSONObject(i);
                if (e == null) continue;
                String buyBy = e.optString("buyBy");
                if (!buyBy.isEmpty() && buyBy.compareTo(today) < 0) continue;
                out.add(new String[]{e.optString("id"), e.optString("title"), e.optString("body")});
                if (buyBy.equals(today)) out.add(new String[]{e.optString("id") + "-last", "Last day — " + e.optString("title"), e.optString("body")});
            }
            JSONArray st = A.optJSONArray("setups");
            if (st != null) {
                List<JSONObject> fresh = new ArrayList<>();
                for (int i = 0; i < st.length(); i++) {
                    JSONObject s = st.optJSONObject(i);
                    if (s == null) continue;
                    setupSyms.add(s.optString("sym"));
                    if (!seen.contains(s.optString("id"))) fresh.add(s);
                }
                if (kSetup && fresh.size() == 1) out.add(new String[]{fresh.get(0).optString("id"), fresh.get(0).optString("title"), fresh.get(0).optString("body")});
                else if (kSetup && fresh.size() > 1) {
                    StringBuilder names = new StringBuilder();
                    for (JSONObject s : fresh) { if (names.length() > 0) names.append(", "); names.append(s.optString("sym")); seen.add(s.optString("id")); }
                    out.add(new String[]{"setups-" + names, "Strong numbers, quiet price: " + names,
                        "Edge-ranked stocks with strong fundamentals whose price hasn’t moved yet. In testing these beat the market over 3 months about as often as ones already rising. Open the app for each one’s numbers."});
                }
            }
            JSONArray news = A.optJSONArray("news");
            if (kNews && news != null) for (int i = 0; i < news.length(); i++) {
                JSONObject n = news.optJSONObject(i);
                if (n == null) continue;
                String sym = n.optString("sym");
                if (held.contains(sym) || setupSyms.contains(sym))
                    out.add(new String[]{n.optString("id"), sym + " · " + n.optString("kind") + (held.contains(sym) ? " (you hold it)" : " (quiet setup)"), n.optString("title")});
            }
        }
        int posted = 0, waiting = 0;
        boolean blocked = false;
        for (String[] n : out) {
            if (n[0].isEmpty() || seen.contains(n[0])) continue;
            if (posted >= MAX_PER_RUN) { waiting++; continue; }
            if (post(ctx, n[0], n[1], n[2])) { seen.add(n[0]); seenArr.put(n[0]); posted++; } else { blocked = true; break; }
        }
        // remember combined-setup ids too, and keep the list from growing without limit
        JSONArray keep = new JSONArray();
        List<String> all = new ArrayList<>(seen);
        for (int i = Math.max(0, all.size() - 600); i < all.size(); i++) keep.put(all.get(i));
        sp.edit().putString("seen", keep.toString()).apply();
        String result = blocked ? "Android is blocking this app’s notifications — allow them in Settings"
            : (err != null ? "couldn’t read the alerts file (" + err + "); review dates still checked. " : "")
              + (posted == 0 ? "nothing new" : posted + " new alert" + (posted > 1 ? "s" : "")) + (waiting > 0 ? ", " + waiting + " more next check" : "")
              + (A != null ? " · data from " + A.optString("asof") : "");
        note(ctx, result);
        return result;
    }
}
