package com.kisushotto.pagos;

import android.accessibilityservice.AccessibilityService;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Servicio de accesibilidad: graba en modo aprendizaje (Recorder) y, con el telefono
 * vinculado, pide al servidor la siguiente orden cada pocos segundos y la paga en BDV
 * con el Driver (una a la vez).
 */
public class PayService extends AccessibilityService {
    static volatile PayService instance;
    static final List<String> LOG = new ArrayList<>();
    static volatile String mode = "?";
    static volatile Driver current;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final Runnable snap = () -> Recorder.snapshot(getRootInActiveWindow(), "cambio");
    private final Runnable poll = this::poll;
    private boolean polling = false;

    static synchronized void log(String s) {
        LOG.add(0, new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + "  " + s);
        while (LOG.size() > 60) LOG.remove(LOG.size() - 1);
    }

    @Override protected void onServiceConnected() { instance = this; log("Servicio activo"); h.postDelayed(poll, 2000); }
    @Override public boolean onUnbind(android.content.Intent i) { instance = null; h.removeCallbacksAndMessages(null); return super.onUnbind(i); }
    @Override public void onInterrupt() { }

    private void poll() {
        h.removeCallbacks(poll);
        long wait = 6000;
        if (current == null && !polling && Store.token(this) != null && !Store.paused(this) && !Recorder.recording) {
            polling = true;
            String tok = Store.token(this);
            net.execute(() -> {
                JSONObject r = null;
                try { r = Api.call(tok, "/dev-next", new JSONObject()); } catch (Exception e) { mode = "sin conexión"; }
                JSONObject fr = r;
                h.post(() -> { polling = false; onNext(fr); });
            });
        }
        h.postDelayed(poll, wait);
    }

    private void onNext(JSONObject r) {
        if (r == null) return;
        if (r.optInt("_status") == 401) { mode = "no vinculado"; return; }
        mode = r.optString("mode", "?");
        if (r.has("skipped")) log("✋ Orden saltada: " + r.optString("skipped"));
        JSONObject job = r.optJSONObject("job");
        if (job == null || current != null) return;
        if (Store.pkg(this) == null) { log("✗ Elige la app de BDV en KS Pagos"); return; }
        current = new Driver(this, job, mode, r.optString("resume", null), PayService::log, () -> current = null);
        current.start();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        if (!Recorder.recording || Recorder.skip(e.getPackageName())) return;
        String pkg = String.valueOf(e.getPackageName());
        if (!Recorder.versions.containsKey(pkg)) {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(pkg, 0);
                Recorder.versions.put(pkg, pi.versionName + " (" + pi.getLongVersionCode() + ")");
            } catch (Exception ex) { Recorder.versions.put(pkg, "?"); }
        }
        switch (e.getEventType()) {
            case AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED:
                h.removeCallbacks(snap);
                h.postDelayed(() -> Recorder.snapshot(getRootInActiveWindow(), "pantalla"), 350);
                break;
            case AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED:
                h.removeCallbacks(snap);
                h.postDelayed(snap, 700);
                break;
            default:
                Recorder.event(e);
        }
    }
}
