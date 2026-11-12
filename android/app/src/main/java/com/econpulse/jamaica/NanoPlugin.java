package com.econpulse.jamaica;

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

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * On-device Gemini Nano through AICore (ML Kit GenAI Prompt API). Everything runs on the phone.
 * Tries the preview model first (Gemini Nano 4 Full / Fast, AICore developer preview), then the stable model.
 * JS: Capacitor.Plugins.Nano.status(), .download(), .generate({ prompt, maxTokens, temperature })
 */
@CapacitorPlugin(name = "Nano")
public class NanoPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private GenerativeModelFutures model;
    private String stage = "";
    private String pref = "";
    private int lastStatus = -1;
    private volatile boolean downloading = false;
    private volatile long downloaded = 0;

    private static GenerativeModelFutures client(int releaseStage, int preference) {
        ModelConfig.Builder mb = new ModelConfig.Builder();
        mb.setReleaseStage(releaseStage);
        mb.setPreference(preference);
        GenerationConfig.Builder gb = new GenerationConfig.Builder();
        gb.setModelConfig(mb.build());
        return GenerativeModelFutures.from(Generation.INSTANCE.getClient(gb.build()));
    }

    /** Pick the best model this phone offers. Must run off the main thread. */
    private synchronized void choose() throws Exception {
        if (model != null && lastStatus != FeatureStatus.UNAVAILABLE) return;
        int[][] tries = {
            {ModelReleaseStage.PREVIEW, ModelPreference.FULL},
            {ModelReleaseStage.PREVIEW, ModelPreference.FAST},
            {ModelReleaseStage.STABLE, ModelPreference.FULL},
        };
        GenerativeModelFutures fallback = null; int fallbackStatus = FeatureStatus.UNAVAILABLE; String fs = "", fp = "";
        for (int[] t : tries) {
            GenerativeModelFutures m;
            int s;
            try {
                m = client(t[0], t[1]);
                s = m.checkStatus().get(30, TimeUnit.SECONDS);
            } catch (Exception e) { continue; }
            String st = t[0] == ModelReleaseStage.PREVIEW ? "preview" : "stable";
            String pr = t[1] == ModelPreference.FULL ? "full" : "fast";
            if (s == FeatureStatus.AVAILABLE) { model = m; lastStatus = s; stage = st; pref = pr; return; }
            if (fallback == null && s != FeatureStatus.UNAVAILABLE) { fallback = m; fallbackStatus = s; fs = st; fp = pr; }
        }
        model = fallback; lastStatus = fallback == null ? FeatureStatus.UNAVAILABLE : fallbackStatus; stage = fs; pref = fp;
    }

    private JSObject describe() {
        JSObject r = new JSObject();
        String s = lastStatus == FeatureStatus.AVAILABLE ? "available"
            : lastStatus == FeatureStatus.DOWNLOADABLE ? "downloadable"
            : lastStatus == FeatureStatus.DOWNLOADING || downloading ? "downloading" : "unavailable";
        r.put("status", s);
        r.put("stage", stage);
        r.put("preference", pref);
        r.put("downloadedBytes", downloaded);
        if (model != null && lastStatus == FeatureStatus.AVAILABLE) {
            try { r.put("model", model.getBaseModelName().get(10, TimeUnit.SECONDS)); } catch (Exception ignored) { }
        }
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        worker.execute(() -> {
            try {
                if (model != null && lastStatus != FeatureStatus.AVAILABLE) {
                    try { lastStatus = model.checkStatus().get(30, TimeUnit.SECONDS); } catch (Exception ignored) { }
                    if (lastStatus == FeatureStatus.UNAVAILABLE) model = null;
                }
                choose();
                call.resolve(describe());
            } catch (Throwable e) {
                JSObject r = new JSObject(); r.put("status", "unavailable"); r.put("error", String.valueOf(e.getMessage()));
                call.resolve(r);
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        worker.execute(() -> {
            try {
                choose();
                if (model == null) { call.reject("Gemini Nano isn't offered on this phone"); return; }
                if (lastStatus == FeatureStatus.AVAILABLE) { call.resolve(describe()); return; }
                downloading = true;
                model.download(new DownloadCallback() {
                    @Override public void onDownloadProgress(long bytes) { downloaded = bytes; }
                    @Override public void onDownloadCompleted() { downloading = false; lastStatus = FeatureStatus.AVAILABLE; }
                    @Override public void onDownloadFailed(GenAiException e) { downloading = false; }
                });
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
            try {
                choose();
                if (model == null || lastStatus != FeatureStatus.AVAILABLE) { call.reject("Gemini Nano isn't ready on this phone"); return; }
                GenerateContentRequest.Builder b = new GenerateContentRequest.Builder(new TextPart(prompt));
                b.setTemperature(temperature);
                b.setTopK(16);
                b.setMaxOutputTokens(maxTokens);
                GenerateContentResponse res = model.generateContent(b.build()).get(180, TimeUnit.SECONDS);
                List<Candidate> c = res.getCandidates();
                String text = c == null || c.isEmpty() ? "" : c.get(0).getText();
                JSObject r = new JSObject();
                r.put("text", text == null ? "" : text);
                r.put("stage", stage);
                r.put("preference", pref);
                call.resolve(r);
            } catch (Throwable e) {
                Throwable root = e.getCause() != null ? e.getCause() : e;
                call.reject(String.valueOf(root.getMessage()));
            }
        });
    }
}
