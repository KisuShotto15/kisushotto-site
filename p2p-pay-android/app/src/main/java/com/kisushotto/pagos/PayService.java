package com.kisushotto.pagos;

import android.accessibilityservice.AccessibilityService;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;

/** Servicio de accesibilidad. Fase 1: solo graba (Recorder) mientras el modo aprendizaje esta activo. */
public class PayService extends AccessibilityService {
    static volatile PayService instance;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable snap = () -> Recorder.snapshot(getRootInActiveWindow(), "cambio");

    @Override protected void onServiceConnected() { instance = this; }
    @Override public boolean onUnbind(android.content.Intent i) { instance = null; return super.onUnbind(i); }
    @Override public void onInterrupt() { }

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
                // Muchos eventos seguidos: una sola foto del arbol cuando se calma.
                h.removeCallbacks(snap);
                h.postDelayed(snap, 700);
                break;
            default:
                Recorder.event(e);
        }
    }
}
