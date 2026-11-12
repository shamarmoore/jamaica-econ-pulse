package com.econpulse.jamaica;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.prompt.Candidate;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.GenerationConfig;
import com.google.mlkit.genai.prompt.ModelConfig;
import com.google.mlkit.genai.prompt.ModelPreference;
import com.google.mlkit.genai.prompt.ModelReleaseStage;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * On-device Gemini Nano through AICore (ML Kit GenAI Prompt API). Everything runs on the phone.
 * Candidates, best first: Nano 4 Full (preview) → Nano 4 Fast (preview) → stable Nano.
 * The preview Full model can report AVAILABLE yet fail every request (known AICore preview bug), so a model that
 * fails is marked broken for a week and the next one answers instead. The user can also pin one model.
 * JS: Capacitor.Plugins.Nano.status(), .download(), .generate({ prompt, maxTokens, temperature }), .setMode({ mode })
 */
@CapacitorPlugin(name = "Nano")
public class NanoPlugin extends Plugin {
    private static final String[] KEYS = {"full", "fast", "stable"};
    private static final long RETRY_MS = 7L * 24 * 3600 * 1000;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final GenerativeModelFutures[] models = new GenerativeModelFutures[3];
    private final int[] statuses = {-1, -1, -1};
    private volatile boolean downloading = false;
    private volatile long downloaded = 0;
    private String lastError = "";

    private SharedPreferences prefs() { return getContext().getSharedPreferences("nano", Context.MODE_PRIVATE); }
    private String mode() { return prefs().getString("mode", "auto"); }
    private boolean broken(int i) { return System.currentTimeMillis() - prefs().getLong("broken_" + KEYS[i], 0) < RETRY_MS; }
    private void markBroken(int i, boolean b) { prefs().edit().putLong("broken_" + KEYS[i], b ? System.currentTimeMillis() : 0).apply(); }

    private static GenerativeModelFutures client(int i) {
        ModelConfig.Builder mb = new ModelConfig.Builder();
        mb.setReleaseStage(i == 2 ? ModelReleaseStage.STABLE : ModelReleaseStage.PREVIEW);
        mb.setPreference(i == 1 ? ModelPreference.FAST : ModelPreference.FULL);
        GenerationConfig.Builder gb = new GenerationConfig.Builder();
        gb.setModelConfig(mb.build());
        return GenerativeModelFutures.from(Generation.INSTANCE.getClient(gb.build()));
    }

    /** Refresh each candidate's status. Off the main thread only. */
    private void probe(boolean force) {
        for (int i = 0; i < 3; i++) {
            if (!force && statuses[i] == FeatureStatus.AVAILABLE) continue;
            try {
                if (models[i] == null) models[i] = client(i);
                statuses[i] = models[i].checkStatus().get(30, TimeUnit.SECONDS);
            } catch (Throwable e) { statuses[i] = FeatureStatus.UNAVAILABLE; }
        }
    }

    /** Usable models in the order they should be tried. */
    private List<Integer> order() {
        List<Integer> out = new ArrayList<>();
        String m = mode();
        for (int i = 0; i < 3; i++) if (m.equals(KEYS[i]) && statuses[i] == FeatureStatus.AVAILABLE) out.add(i);
        if (!out.isEmpty()) return out; // pinned model
        for (int i = 0; i < 3; i++) if (statuses[i] == FeatureStatus.AVAILABLE && !broken(i)) out.add(i);
        for (int i = 0; i < 3; i++) if (statuses[i] == FeatureStatus.AVAILABLE && broken(i)) out.add(i); // last resort
        return out;
    }

    private String nameOf(int i) {
        try { return models[i].getBaseModelName().get(10, TimeUnit.SECONDS); } catch (Throwable e) { return ""; }
    }

    private JSObject describe() {
        JSObject r = new JSObject();
        List<Integer> o = order();
        String s;
        if (!o.isEmpty()) s = "available";
        else if (downloading) s = "downloading";
        else {
            boolean dl = false, ing = false;
            for (int st : statuses) { dl |= st == FeatureStatus.DOWNLOADABLE; ing |= st == FeatureStatus.DOWNLOADING; }
            s = ing ? "downloading" : dl ? "downloadable" : "unavailable";
        }
        r.put("status", s);
        r.put("mode", mode());
        r.put("downloadedBytes", downloaded);
        if (!o.isEmpty()) {
            int i = o.get(0);
            r.put("current", KEYS[i]);
            r.put("stage", i == 2 ? "stable" : "preview");
            r.put("preference", i == 1 ? "fast" : "full");
            r.put("model", nameOf(i));
        }
        JSArray all = new JSArray();
        for (int i = 0; i < 3; i++) {
            JSObject c = new JSObject();
            c.put("key", KEYS[i]);
            c.put("status", statuses[i] == FeatureStatus.AVAILABLE ? "available" : statuses[i] == FeatureStatus.DOWNLOADABLE ? "downloadable"
                : statuses[i] == FeatureStatus.DOWNLOADING ? "downloading" : "unavailable");
            c.put("broken", broken(i));
            all.put(c);
        }
        r.put("models", all);
        if (!lastError.isEmpty()) r.put("lastError", lastError);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        final boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        worker.execute(() -> {
            try { probe(force); call.resolve(describe()); }
            catch (Throwable e) { JSObject r = new JSObject(); r.put("status", "unavailable"); r.put("error", String.valueOf(e.getMessage())); call.resolve(r); }
        });
    }

    @PluginMethod
    public void setMode(PluginCall call) {
        String m = call.getString("mode", "auto");
        boolean ok = "auto".equals(m);
        for (String k : KEYS) ok |= k.equals(m);
        if (!ok) { call.reject("unknown mode"); return; }
        prefs().edit().putString("mode", m).apply();
        if ("auto".equals(m)) for (int i = 0; i < 3; i++) markBroken(i, false); // give every model a fresh chance
        worker.execute(() -> { probe(true); call.resolve(describe()); });
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String want = call.getString("key", "");
        worker.execute(() -> {
            try {
                probe(true);
                if ((want == null || want.isEmpty()) && !order().isEmpty()) { call.resolve(describe()); return; }
                for (int i = 0; i < 3; i++) {
                    if (statuses[i] != FeatureStatus.DOWNLOADABLE) continue;
                    if (want != null && !want.isEmpty() && !want.equals(KEYS[i])) continue;
                    downloading = true;
                    final int k = i;
                    models[i].download(new DownloadCallback() {
                        @Override public void onDownloadProgress(long bytes) { downloaded = bytes; }
                        @Override public void onDownloadCompleted() { downloading = false; statuses[k] = FeatureStatus.AVAILABLE; }
                        @Override public void onDownloadFailed(GenAiException e) { downloading = false; lastError = String.valueOf(e.getMessage()); }
                    });
                    break;
                }
                call.resolve(describe());
            } catch (Throwable e) { downloading = false; call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void generate(PluginCall call) {
        final String prompt = call.getString("prompt", "");
        final int maxTokens = call.getInt("maxTokens", 400);
        final float temperature = call.getFloat("temperature", 0.2f);
        if (prompt == null || prompt.isEmpty()) { call.reject("empty prompt"); return; }
        worker.execute(() -> {
            probe(false);
            List<Integer> o = order();
            if (o.isEmpty()) { call.reject("Gemini Nano isn't ready on this phone"); return; }
            StringBuilder errs = new StringBuilder();
            for (int i : o) {
                try {
                    GenerateContentRequest.Builder b = new GenerateContentRequest.Builder(new TextPart(prompt));
                    b.setTemperature(temperature);
                    b.setTopK(16);
                    b.setMaxOutputTokens(maxTokens);
                    GenerateContentResponse res = models[i].generateContent(b.build()).get(180, TimeUnit.SECONDS);
                    List<Candidate> c = res.getCandidates();
                    String text = c == null || c.isEmpty() ? "" : c.get(0).getText();
                    if (text == null || text.trim().isEmpty()) throw new IllegalStateException("empty answer");
                    if (broken(i)) markBroken(i, false);
                    JSObject r = new JSObject();
                    r.put("text", text);
                    r.put("used", KEYS[i]);
                    r.put("model", nameOf(i));
                    r.put("fellBack", errs.length() > 0);
                    if (errs.length() > 0) r.put("fallbackReason", errs.toString());
                    call.resolve(r);
                    return;
                } catch (Throwable e) {
                    Throwable root = e.getCause() != null ? e.getCause() : e;
                    lastError = KEYS[i] + ": " + root.getMessage();
                    errs.append(lastError).append('\n');
                    if (!mode().equals(KEYS[i])) markBroken(i, true);
                }
            }
            call.reject(errs.toString().trim());
        });
    }
}
