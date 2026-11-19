package com.kisushotto.pagos;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private TextView status, counter, saved;
    private Button perm, rec, share;
    private Uri lastFile;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override public void run() { refresh(); if (Recorder.recording) h.postDelayed(this, 1000); }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        int pad = dp(18);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(Color.BLACK);

        TextView title = text("KS Pagos · aprendizaje", 22, 0xFFF0B90B);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        col.addView(text("Fase 1: grabo cómo son las pantallas de BDV mientras haces una transferencia a mano. "
                + "No se toman capturas: solo botones, campos y textos, con los números largos y las claves enmascarados.", 14, 0xFFB0B8C4));

        status = text("", 15, Color.WHITE);
        col.addView(status);
        perm = button("1. Activar el permiso de accesibilidad", v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        col.addView(perm);
        col.addView(text("Si Android lo muestra en gris (\"configuración restringida\"): Ajustes → Apps → KS Pagos → ⋮ (arriba a la derecha) → \"Permitir configuración restringida\", y vuelve a intentar.", 13, 0xFF8B949E));

        rec = button("", v -> toggle());
        col.addView(rec);
        counter = text("", 14, 0xFFB0B8C4);
        col.addView(counter);
        col.addView(text("Mientras grabas: abre BDV, inicia sesión con tu clave y haz una transferencia BDV → BDV completa hasta ver el comprobante. "
                + "Mejor 2 o 3 transferencias, y que alguna incluya una cuenta nueva (no guardada en favoritos). Usa solo BDV mientras grabas.", 13, 0xFF8B949E));

        saved = text("", 14, 0xFF1D9E75);
        col.addView(saved);
        share = button("3. Compartir el archivo", v -> shareFile());
        share.setEnabled(false);
        col.addView(share);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.BLACK);
        sv.addView(col);
        setContentView(sv);
    }

    @Override protected void onResume() { super.onResume(); refresh(); if (Recorder.recording) h.post(tick); }
    @Override protected void onPause() { super.onPause(); h.removeCallbacks(tick); }

    private void refresh() {
        boolean on = PayService.instance != null;
        status.setText(on ? "✓ Permiso de accesibilidad activo" : "✗ Falta activar el permiso de accesibilidad");
        status.setTextColor(on ? 0xFF1D9E75 : 0xFFE24B4A);
        perm.setVisibility(on ? android.view.View.GONE : android.view.View.VISIBLE);
        rec.setEnabled(on);
        rec.setText(Recorder.recording ? "⏹ Detener y guardar" : "2. ⏺ Empezar a grabar");
        counter.setText(Recorder.recording || Recorder.count() > 0
                ? Recorder.screens + " pantallas · " + Recorder.count() + " eventos" + (Recorder.recording ? " · grabando…" : "")
                : "");
    }

    private void toggle() {
        if (!Recorder.recording) {
            Recorder.start();
            saved.setText("");
            h.post(tick);
            // Directo a BDV si esta instalada (cualquier paquete que se llame bdv/venezuela)
            Intent bdv = findBdv();
            if (bdv != null) startActivity(bdv);
        } else {
            Recorder.stop();
            save();
        }
        refresh();
    }

    private Intent findBdv() {
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (android.content.pm.ResolveInfo ri : getPackageManager().queryIntentActivities(main, 0)) {
            String p = ri.activityInfo.packageName;
            if (p.toLowerCase(Locale.ROOT).matches(".*(bdv|bancodevenezuela|venezuela).*")) {
                return getPackageManager().getLaunchIntentForPackage(p);
            }
        }
        return null;
    }

    private void save() {
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            String json = Recorder.toJson(dm.widthPixels, dm.heightPixels);
            String name = "bdv-aprendizaje-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".json";
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            lastFile = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            try (OutputStream os = getContentResolver().openOutputStream(lastFile)) {
                os.write(json.getBytes(StandardCharsets.UTF_8));
            }
            saved.setText("✓ Guardado en Descargas: " + name + " (" + (json.length() / 1024) + " KB)");
            share.setEnabled(true);
        } catch (Exception e) {
            saved.setText("Error al guardar: " + e.getMessage());
            saved.setTextColor(0xFFE24B4A);
        }
    }

    private void shareFile() {
        if (lastFile == null) return;
        Intent s = new Intent(Intent.ACTION_SEND);
        s.setType("application/json");
        s.putExtra(Intent.EXTRA_STREAM, lastFile);
        s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(s, "Compartir aprendizaje"));
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setPadding(0, dp(8), 0, dp(8));
        return t;
    }

    private Button button(String s, android.view.View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        b.setLayoutParams(lp);
        b.setGravity(Gravity.CENTER);
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
