package com.econpulse.jamaica;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Notifications for the JSE plan. The web app hands over what the background check needs (read-only GitHub token,
 * the symbols and review dates of the user's positions, which kinds of alert are on); AlertsWorker does the rest.
 * JS: Capacitor.Plugins.Alerts.sync({ enabled, config }), .status(), .requestPermission(), .checkNow(), .test()
 */
@CapacitorPlugin(name = "Alerts", permissions = { @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }) })
public class AlertsPlugin extends Plugin {
    private static final String WORK = "jse-alerts";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() { return getContext().getSharedPreferences(AlertsWorker.PREFS, Context.MODE_PRIVATE); }

    private boolean allowed() {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) return false;
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    private JSObject describe() {
        SharedPreferences sp = prefs();
        JSObject r = new JSObject();
        r.put("enabled", sp.getBoolean("enabled", false));
        r.put("allowed", allowed());
        r.put("lastRun", sp.getLong("lastRun", 0));
        r.put("lastResult", sp.getString("lastResult", ""));
        return r;
    }

    private void schedule(boolean on) {
        WorkManager wm = WorkManager.getInstance(getContext());
        if (!on) { wm.cancelUniqueWork(WORK); return; }
        Constraints cs = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(AlertsWorker.class, 6, TimeUnit.HOURS).setConstraints(cs).build();
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    @PluginMethod
    public void sync(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSObject cfg = call.getObject("config", new JSObject());
        prefs().edit().putBoolean("enabled", enabled).putString("config", cfg == null ? "{}" : cfg.toString()).apply();
        try { schedule(enabled); } catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); return; }
        call.resolve(describe());
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(describe()); }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) { call.resolve(describe()); return; }
        requestPermissionForAlias("notifications", call, "permissionDone");
    }

    @PermissionCallback
    private void permissionDone(PluginCall call) { call.resolve(describe()); }

    @PluginMethod
    public void checkNow(PluginCall call) {
        worker.execute(() -> {
            try { AlertsWorker.run(getContext()); } catch (Throwable e) {
                prefs().edit().putLong("lastRun", System.currentTimeMillis()).putString("lastResult", "error: " + e.getMessage()).apply();
            }
            call.resolve(describe());
        });
    }

    @PluginMethod
    public void test(PluginCall call) {
        boolean ok = AlertsWorker.post(getContext(), "test-" + System.currentTimeMillis(), "JA Econ Pulse alerts are on",
            "You’ll hear about sell signals, reviews that are due and dividend buy-by dates here.");
        JSObject r = describe();
        r.put("posted", ok);
        call.resolve(r);
    }
}
