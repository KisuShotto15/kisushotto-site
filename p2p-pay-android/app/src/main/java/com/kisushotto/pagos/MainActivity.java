package com.kisushotto.pagos;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.InputType;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    // Apps donde puede vivir BDV: la oficial o el clonador que la contiene.
    static final String[] BDV_PKGS = { "com.bancodevenezuela.bdvdigital", "com.excelliance.multiaccounts" };

    private TextView status, pairSt, pwSt, pkgSt, modeSt, logV, counter, saved;
    private EditText code, pw;
    private Button perm, pause, rec, share, pkgBtn;
    private LinearLayout pairBox;
    private Uri lastFile;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() { @Override public void run() { refresh(); h.postDelayed(this, 1000); } };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        int pad = dp(18);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(Color.BLACK);

        TextView title = text("KS Pagos", 24, 0xFFF0B90B);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        status = text("", 15, Color.WHITE);
        col.addView(status);
        perm = button("Activar el permiso de accesibilidad", v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        col.addView(perm);

        // ── Vincular ──
        col.addView(section("1 · Vincular con tu cuenta"));
        pairSt = text("", 14, 0xFFB0B8C4);
        col.addView(pairSt);
        pairBox = new LinearLayout(this);
        pairBox.setOrientation(LinearLayout.VERTICAL);
        pairBox.addView(text("En la app P2P: Bots → Binance → Asistente de pago → 📱 Vincular teléfono, y escribe aquí el código.", 13, 0xFF8B949E));
        code = input("Código de 6 dígitos", InputType.TYPE_CLASS_NUMBER);
        pairBox.addView(code);
        pairBox.addView(button("Vincular", v -> pair()));
        col.addView(pairBox);

        // ── Clave ──
        col.addView(section("2 · Clave de BDV"));
        col.addView(text("Se guarda cifrada solo en este teléfono (Keystore de Android). Nunca va al servidor. En BDV desactiva el ingreso con huella.", 13, 0xFF8B949E));
        pw = input("Clave de ingreso de BDV", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        col.addView(pw);
        col.addView(button("Guardar clave", v -> savePw()));
        pwSt = text("", 14, 0xFFB0B8C4);
        col.addView(pwSt);

        // ── App ──
        col.addView(section("3 · App de BDV"));
        pkgSt = text("", 14, 0xFFB0B8C4);
        col.addView(pkgSt);
        pkgBtn = button("Cambiar", v -> cyclePkg());
        col.addView(pkgBtn);

        // ── Estado ──
        col.addView(section("Estado"));
        modeSt = text("", 15, Color.WHITE);
        col.addView(modeSt);
        pause = button("", v -> { Store.paused(this, !Store.paused(this)); refresh(); });
        col.addView(pause);
        col.addView(text("Deja el teléfono cargando, con la pantalla encendida y desbloqueada (Opciones de desarrollador → Pantalla activa al cargar), y sin optimización de batería para KS Pagos.", 13, 0xFF8B949E));
        logV = text("", 12, 0xFFB0B8C4);
        logV.setTypeface(Typeface.MONOSPACE);
        col.addView(logV);

        // ── Aprendizaje ──
        col.addView(section("Modo aprendizaje (solo si BDV cambia)"));
        rec = button("", v -> toggleRec());
        col.addView(rec);
        counter = text("", 14, 0xFFB0B8C4);
        col.addView(counter);
        saved = text("", 14, 0xFF1D9E75);
        col.addView(saved);
        share = button("Compartir el archivo", v -> shareFile());
        share.setEnabled(false);
        col.addView(share);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.BLACK);
        sv.addView(col);
        setContentView(sv);
        if (Store.pkg(this) == null) autoPkg();
    }

    @Override protected void onResume() { super.onResume(); h.post(tick); }
    @Override protected void onPause() { super.onPause(); h.removeCallbacks(tick); }

    private void refresh() {
        boolean on = PayService.instance != null;
        status.setText(on ? "✓ Permiso de accesibilidad activo" : "✗ Falta activar el permiso de accesibilidad");
        status.setTextColor(on ? 0xFF1D9E75 : 0xFFE24B4A);
        perm.setVisibility(on ? View.GONE : View.VISIBLE);
        boolean paired = Store.token(this) != null;
        pairSt.setText(paired ? "✓ Vinculado" : "Sin vincular");
        pairSt.setTextColor(paired ? 0xFF1D9E75 : 0xFFB0B8C4);
        pairBox.setVisibility(paired ? View.GONE : View.VISIBLE);
        pwSt.setText(Store.hasPassword(this) ? "✓ Clave guardada" : "Sin clave guardada");
        String pk = Store.pkg(this);
        pkgSt.setText(pk == null ? "No encontré BDV instalada" : (pk.equals(BDV_PKGS[0]) ? "BDV oficial" : "BDV dentro del clonador") + " (" + pk + ")");
        String m = PayService.mode;
        String ml = "auto".equals(m) ? "Automático" : "dry".equals(m) ? "Ensayo (se detiene antes de confirmar)" : "off".equals(m) ? "Apagado (se cambia en la app P2P)" : m;
        Driver d = PayService.current;
        modeSt.setText("Modo: " + ml + (Store.paused(this) ? " · ⏸ en pausa" : "") + (d != null ? "\nPagando orden …" + Driver.last(d.orderNo, 4) : ""));
        pause.setText(Store.paused(this) ? "▶ Reanudar" : "⏸ Pausar pagos");
        StringBuilder sb = new StringBuilder();
        synchronized (PayService.class) { for (int i = 0; i < Math.min(25, PayService.LOG.size()); i++) sb.append(PayService.LOG.get(i)).append('\n'); }
        logV.setText(sb.toString());
        rec.setEnabled(on);
        rec.setText(Recorder.recording ? "⏹ Detener y guardar" : "⏺ Empezar a grabar");
        counter.setText(Recorder.recording || Recorder.count() > 0
                ? Recorder.screens + " pantallas · " + Recorder.count() + " eventos" + (Recorder.recording ? " · grabando…" : "") : "");
    }

    private void pair() {
        String c = code.getText().toString().trim();
        if (c.length() != 6) { pairSt.setText("El código tiene 6 dígitos"); return; }
        pairSt.setText("Vinculando…");
        Executors.newSingleThreadExecutor().execute(() -> {
            String msg;
            try {
                JSONObject r = Api.call(null, "/dev-pair", new JSONObject().put("code", c).put("name", Build.MANUFACTURER + " " + Build.MODEL));
                if (r.optString("token", null) != null) { Store.token(this, r.getString("token")); msg = "✓ Vinculado"; }
                else msg = "✗ " + r.optString("error", "no se pudo vincular");
            } catch (Exception e) { msg = "✗ " + e.getMessage(); }
            String fm = msg;
            h.post(() -> { pairSt.setText(fm); code.setText(""); refresh(); });
        });
    }

    private void savePw() {
        String v = pw.getText().toString();
        if (v.isEmpty()) return;
        try { Store.password(this, v); pw.setText(""); pwSt.setText("✓ Clave guardada"); }
        catch (Exception e) { pwSt.setText("✗ " + e.getMessage()); }
    }

    private List<String> installed() {
        List<String> out = new ArrayList<>();
        for (String p : BDV_PKGS) if (getPackageManager().getLaunchIntentForPackage(p) != null) out.add(p);
        return out;
    }
    private void autoPkg() { List<String> l = installed(); if (!l.isEmpty()) Store.pkg(this, l.get(0)); }
    private void cyclePkg() {
        List<String> l = installed();
        if (l.isEmpty()) return;
        int i = l.indexOf(Store.pkg(this));
        Store.pkg(this, l.get((i + 1) % l.size()));
        refresh();
    }

    private void toggleRec() {
        if (!Recorder.recording) {
            Recorder.start();
            saved.setText("");
            String pk = Store.pkg(this);
            Intent i = pk == null ? null : getPackageManager().getLaunchIntentForPackage(pk);
            if (i != null) startActivity(i);
        } else {
            Recorder.stop();
            save();
        }
        refresh();
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
            try (OutputStream os = getContentResolver().openOutputStream(lastFile)) { os.write(json.getBytes(StandardCharsets.UTF_8)); }
            saved.setText("✓ Guardado en Descargas: " + name);
            share.setEnabled(true);
        } catch (Exception e) { saved.setText("Error al guardar: " + e.getMessage()); }
    }

    private void shareFile() {
        if (lastFile == null) return;
        Intent s = new Intent(Intent.ACTION_SEND);
        s.setType("application/json");
        s.putExtra(Intent.EXTRA_STREAM, lastFile);
        s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(s, "Compartir aprendizaje"));
    }

    private TextView section(String s) {
        TextView t = text(s, 16, 0xFFF0B90B);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(18), 0, dp(4));
        return t;
    }
    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }
    private EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint); e.setInputType(type);
        e.setTextColor(Color.WHITE); e.setHintTextColor(0xFF6B7480);
        return e;
    }
    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s); b.setAllCaps(false); b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        b.setLayoutParams(lp);
        b.setGravity(Gravity.CENTER);
        return b;
    }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
