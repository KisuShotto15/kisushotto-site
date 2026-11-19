package com.kisushotto.pagos;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Maneja la app de BDV (Flutter: sin ids, se guia por etiquetas y hints) para una
 * orden: ingresar → Transferencias → Cuentas de terceros → cuenta/monto/concepto →
 * Transferir → (servidor valida lo que muestra "Confirmar Operación") → Confirmar →
 * clave → comprobante → captura al servidor. En Ensayo se detiene en "Confirmar
 * Operación" y espera a que la persona confirme; despues toma el comprobante igual.
 * Una vez que se toco Confirmar, ante cualquier problema se abandona sin reintentar.
 */
final class Driver {
    enum Screen { LOGGED_OUT, LOGIN, PASSWORD, HOME, MENU, FORM, CONFIRM, RECEIPT, UNKNOWN }
    enum Stage { START, FORM_SENT, WAIT_HUMAN, CONFIRMING, DONE }

    interface Log { void log(String s); }

    private final PayService svc;
    private final Log log;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Random rnd = new Random();
    final JSONObject job;
    final String orderNo;
    final boolean dry;
    private Stage stage;
    private long startedAt = System.currentTimeMillis(), stageAt = startedAt;
    private int unknown = 0, pwTries = 0, formTicks = 0;
    private boolean busy = false, launched = false, finished = false;
    private Runnable onFinish;

    Driver(PayService svc, JSONObject job, String mode, String resume, Log log, Runnable onFinish) {
        this.svc = svc; this.job = job; this.log = log; this.onFinish = onFinish;
        this.orderNo = job.optString("orderNo");
        this.dry = !"auto".equals(mode);
        // Reanudar despues de un reinicio: si ya se toco Confirmar, solo se busca el comprobante.
        this.stage = "confirmed".equals(resume) ? Stage.CONFIRMING : "filled".equals(resume) ? Stage.WAIT_HUMAN : Stage.START;
    }

    void start() { log.log("▶ Orden …" + last(orderNo, 4) + ": " + job.optString("amount") + " Bs" + (dry ? " (ensayo)" : "")); next(400); }

    private void next(long ms) { if (!finished) h.postDelayed(this::tick, ms + rnd.nextInt(500)); }
    private void setStage(Stage s) { stage = s; stageAt = System.currentTimeMillis(); unknown = 0; }

    private void tick() {
        if (finished || busy) { next(700); return; }
        long now = System.currentTimeMillis();
        long limit = stage == Stage.WAIT_HUMAN ? 8 * 60000 : 4 * 60000;
        if (now - startedAt > limit) { fail("se agotó el tiempo en BDV"); return; }
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        String pkg = Store.pkg(svc);
        if (root == null || pkg == null || !pkg.contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) {
            if (!launched && stage == Stage.START && pkg != null) {
                launched = true;
                android.content.Intent i = svc.getPackageManager().getLaunchIntentForPackage(pkg);
                if (i != null) { i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); svc.startActivity(i); }
                next(2500); return;
            }
            if (++unknown > 25) { fail("BDV no está en pantalla"); return; }
            next(900); return;
        }
        List<AccessibilityNodeInfo> nodes = flatten(root);
        Screen s = classify(nodes);
        switch (s) {
            case RECEIPT:
                if (stage == Stage.CONFIRMING || stage == Stage.WAIT_HUMAN) { receipt(nodes); return; }
                clickDesc(nodes, "Back"); next(1200); return; // comprobante viejo en pantalla
            case PASSWORD: {
                if (++pwTries > 3) { fail("BDV no acepta la clave guardada"); return; }
                String pw = Store.password(svc);
                if (pw == null) { fail("falta guardar la clave de BDV en KS Pagos"); return; }
                AccessibilityNodeInfo f = first(nodes, n -> n.isPassword() || (n.isEditable() && startsWith(n.getHintText(), "Contraseña")));
                if (f == null || !setText(f, pw)) { fail("no pude escribir la clave"); return; }
                h.postDelayed(() -> clickDesc(flatten(svc.getRootInActiveWindow()), "Aceptar"), 600 + rnd.nextInt(400));
                next(2200); return;
            }
            case LOGGED_OUT: clickDesc(nodes, "Iniciar sesión"); next(1500); return;
            case LOGIN: clickDesc(nodes, "Ingresa con tu contraseña"); next(1300); return;
            case HOME:
                if (stage == Stage.START) { clickPrefix(nodes, "Transferencias\nTab"); next(1200); return; }
                break;
            case MENU:
                if (stage == Stage.START) { clickDesc(nodes, "Cuentas de terceros"); next(1500); return; }
                break;
            case FORM:
                if (stage == Stage.START) { fill(nodes); return; }
                if (stage == Stage.FORM_SENT && ++formTicks > 6) { fail("BDV no avanzó al tocar Transferir (revisa la pantalla)"); return; }
                next(900); return;
            case CONFIRM:
                if (stage == Stage.FORM_SENT) { confirm(nodes); return; }
                if (stage == Stage.WAIT_HUMAN) { next(1500); return; }
                break;
            default:
                break;
        }
        // Pantalla no esperada para esta etapa (popup, error, carga lenta).
        int max = stage == Stage.CONFIRMING ? 40 : stage == Stage.WAIT_HUMAN ? 400 : 18;
        if (++unknown > max) { fail("pantalla inesperada en BDV: " + summary(nodes)); return; }
        next(900);
    }

    // ── Pasos ─────────────────────────────────────────
    private void fill(List<AccessibilityNodeInfo> nodes) {
        AccessibilityNodeInfo acc = first(nodes, n -> n.isEditable() && startsWith(n.getHintText(), "Cuenta destino"));
        AccessibilityNodeInfo amt = first(nodes, n -> n.isEditable() && startsWith(n.getHintText(), "Monto"));
        AccessibilityNodeInfo con = first(nodes, n -> n.isEditable() && startsWith(n.getHintText(), "Concepto"));
        if (acc == null || amt == null) { fail("no encontré los campos de la transferencia"); return; }
        long cents = job.optLong("cents");
        String saldo = textOf(first(nodes, n -> startsWith(desc(n), "Saldo disponible")));
        long have = centsOf(saldo);
        if (saldo != null && have >= 0 && have < cents) { fail("saldo insuficiente en BDV"); return; }
        busy = true;
        String account = job.optString("account");
        setText(acc, account);
        h.postDelayed(() -> {
            // El campo de monto le da formato solo: se prueba "370000,00" y, si no queda bien, solo los digitos (centimos).
            AccessibilityNodeInfo a2 = findEdit("Monto");
            String human = (cents / 100) + "," + String.format(java.util.Locale.ROOT, "%02d", cents % 100);
            setText(a2, human);
            h.postDelayed(() -> {
                AccessibilityNodeInfo a3 = findEdit("Monto");
                if (centsOf(textOf(a3)) != cents) setText(a3, String.valueOf(cents));
                h.postDelayed(() -> {
                    AccessibilityNodeInfo c2 = findEdit("Concepto");
                    if (c2 != null) setText(c2, job.optString("concept", "pago"));
                    h.postDelayed(() -> {
                        List<AccessibilityNodeInfo> ns = flatten(svc.getRootInActiveWindow());
                        AccessibilityNodeInfo a = first(ns, n -> n.isEditable() && startsWith(n.getHintText(), "Cuenta destino"));
                        AccessibilityNodeInfo m = first(ns, n -> n.isEditable() && startsWith(n.getHintText(), "Monto"));
                        String accTxt = digits(textOf(a));
                        if (!accTxt.equals(digits(account))) { busy = false; fail("la cuenta no quedó bien escrita en BDV"); return; }
                        if (centsOf(textOf(m)) != cents) { busy = false; fail("el monto no quedó bien escrito en BDV (" + textOf(m) + ")"); return; }
                        log.log("Datos escritos: cuenta …" + last(accTxt, 4) + ", monto " + textOf(m));
                        setStage(Stage.FORM_SENT);
                        clickDesc(ns, "Transferir");
                        busy = false; next(1500);
                    }, 700 + rnd.nextInt(400));
                }, 600 + rnd.nextInt(400));
            }, 700 + rnd.nextInt(400));
        }, 700 + rnd.nextInt(500));
    }

    private void confirm(List<AccessibilityNodeInfo> nodes) {
        String name = valueAfter(nodes, "Nombre:");
        String dest = valueAfter(nodes, "Destino:");
        AccessibilityNodeInfo amtN = first(nodes, n -> desc(n) != null && desc(n).matches("^[\\d.]+,\\d{2} Bs$"));
        String amount = amtN == null ? "" : desc(amtN);
        log.log("BDV muestra: " + amount + " → " + name + " (" + dest + ")");
        busy = true;
        post("/dev-report", o("step", "confirm_seen", "name", name, "dest", dest, "amount", amount), r -> {
            if (r == null || !r.optBoolean("go")) {
                busy = false;
                finish("✋ Detenido: " + (r == null ? "sin respuesta del servidor" : r.optString("reason")), false);
                return;
            }
            if (dry) {
                post("/dev-report", o("step", "filled"), r2 -> {
                    log.log("🧪 Ensayo: datos verificados. Confirma tú en BDV; tomo el comprobante después.");
                    setStage(Stage.WAIT_HUMAN); pwTries = 0; busy = false; next(1500);
                });
                return;
            }
            post("/dev-report", o("step", "confirming"), r2 -> {
                if (r2 == null || !r2.optBoolean("ok")) { busy = false; finish("✋ El servidor no autorizó confirmar", false); return; }
                setStage(Stage.CONFIRMING);
                pwTries = 0;
                clickDesc(flatten(svc.getRootInActiveWindow()), "Confirmar");
                log.log("Confirmar tocado");
                busy = false; next(2000);
            });
        });
    }

    private void receipt(List<AccessibilityNodeInfo> nodes) {
        String all = joinDesc(nodes);
        AccessibilityNodeInfo amtN = first(nodes, n -> desc(n) != null && desc(n).matches("^[\\d.]+,\\d{2} Bs$"));
        String amount = amtN == null ? "" : desc(amtN);
        String ref = match(all, "Operación:\\s*\\n?\\s*(\\d+)");
        String dest = match(all, "Destino:\\s*\\n?\\s*([\\d*]+)");
        busy = true;
        log.log("Comprobante: " + amount + " ref " + ref);
        svc.takeScreenshot(Display.DEFAULT_DISPLAY, Executors.newSingleThreadExecutor(), new AccessibilityService.TakeScreenshotCallback() {
            @Override public void onSuccess(AccessibilityService.ScreenshotResult res) {
                String b64 = null; int w = 0, hh = 0;
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(res.getHardwareBuffer(), res.getColorSpace());
                    Bitmap bm = hw.copy(Bitmap.Config.ARGB_8888, false);
                    float k = Math.min(1f, 720f / bm.getWidth());
                    Bitmap sc = Bitmap.createScaledBitmap(bm, Math.round(bm.getWidth() * k), Math.round(bm.getHeight() * k), true);
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    sc.compress(Bitmap.CompressFormat.JPEG, 78, bo);
                    b64 = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
                    w = sc.getWidth(); hh = sc.getHeight();
                    res.getHardwareBuffer().close();
                } catch (Exception e) { log.log("captura: " + e.getMessage()); }
                sendReceipt(b64, w, hh, amount, ref, dest);
            }
            @Override public void onFailure(int code) {
                log.log("captura falló (" + code + "), envío sin imagen");
                sendReceipt(null, 0, 0, amount, ref, dest);
            }
        });
    }

    private void sendReceipt(String b64, int w, int hh, String amount, String ref, String dest) {
        JSONObject p = o("amount", amount, "ref", ref, "dest", dest);
        try { if (b64 != null) { p.put("image", b64); p.put("w", w); p.put("h", hh); } } catch (Exception ignored) { }
        post("/dev-receipt", p, r -> {
            busy = false;
            boolean ok = r != null && r.optBoolean("ok");
            h.post(() -> clickDesc(flatten(svc.getRootInActiveWindow()), "Back"));
            finish(ok ? "✓ Orden …" + last(orderNo, 4) + " pagada y marcada" : "⚠ Pago hecho, pero: " + (r == null ? "sin respuesta" : r.optString("error")), ok);
        });
    }

    private void fail(String why) {
        if (finished) return;
        log.log("✗ " + why);
        post("/dev-report", o("step", "failed", "reason", why, "stage", stage.name()), r -> { });
        finish(null, false);
    }

    private void finish(String msg, boolean ok) {
        if (finished) return;
        finished = true;
        setStage(Stage.DONE);
        if (msg != null) log.log(msg);
        h.removeCallbacksAndMessages(null);
        if (onFinish != null) onFinish.run();
    }

    // ── Reconocer pantallas ───────────────────────────
    static Screen classify(List<AccessibilityNodeInfo> ns) {
        if (has(ns, "Comprobante de operación")) return Screen.RECEIPT;
        if (first(ns, n -> n.isPassword() || (n.isEditable() && startsWith(n.getHintText(), "Contraseña"))) != null && has(ns, "Aceptar")) return Screen.PASSWORD;
        if (has(ns, "Confirmar Operación")) return Screen.CONFIRM;
        if (first(ns, n -> n.isEditable() && startsWith(n.getHintText(), "Cuenta destino")) != null) return Screen.FORM;
        if (has(ns, "Cuentas de terceros")) return Screen.MENU;
        if (has(ns, "Ingresa con tu contraseña")) return Screen.LOGIN;
        if (first(ns, n -> startsWith(desc(n), "Transferencias\nTab")) != null) return Screen.HOME;
        if (has(ns, "Iniciar sesión")) return Screen.LOGGED_OUT;
        return Screen.UNKNOWN;
    }

    // ── Utilidades de nodos ───────────────────────────
    interface Pred { boolean ok(AccessibilityNodeInfo n); }
    static List<AccessibilityNodeInfo> flatten(AccessibilityNodeInfo root) {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        if (root != null) walk(root, out, 0);
        return out;
    }
    private static void walk(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int d) {
        out.add(n);
        if (d > 50) return;
        for (int i = 0; i < n.getChildCount(); i++) { AccessibilityNodeInfo c = n.getChild(i); if (c != null && c.isVisibleToUser()) walk(c, out, d + 1); }
    }
    static AccessibilityNodeInfo first(List<AccessibilityNodeInfo> ns, Pred p) { for (AccessibilityNodeInfo n : ns) if (p.ok(n)) return n; return null; }
    static String desc(AccessibilityNodeInfo n) { return n == null || n.getContentDescription() == null ? null : n.getContentDescription().toString(); }
    static String textOf(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.getText() != null && n.getText().length() > 0) return n.getText().toString();
        return desc(n);
    }
    static boolean startsWith(CharSequence s, String p) { return s != null && s.toString().trim().startsWith(p); }
    static boolean has(List<AccessibilityNodeInfo> ns, String d) { return first(ns, n -> d.equals(desc(n) == null ? null : desc(n).trim())) != null; }
    private AccessibilityNodeInfo findEdit(String hint) { return first(flatten(svc.getRootInActiveWindow()), n -> n.isEditable() && startsWith(n.getHintText(), hint)); }
    static String valueAfter(List<AccessibilityNodeInfo> ns, String label) {
        for (int i = 0; i < ns.size(); i++) {
            String d = desc(ns.get(i));
            if (d == null) continue;
            String t = d.trim();
            if (t.startsWith(label)) {
                String rest = t.substring(label.length()).trim();
                if (!rest.isEmpty()) return rest;              // "Destino: \n0102****6058" en un solo nodo
                for (int j = i + 1; j < ns.size() && j < i + 4; j++) { String v = desc(ns.get(j)); if (v != null && !v.trim().isEmpty()) return v.trim(); }
            }
        }
        return "";
    }
    static String joinDesc(List<AccessibilityNodeInfo> ns) {
        StringBuilder b = new StringBuilder();
        for (AccessibilityNodeInfo n : ns) { String d = desc(n); if (d != null) b.append(d).append('\n'); }
        return b.toString();
    }
    static String summary(List<AccessibilityNodeInfo> ns) {
        StringBuilder b = new StringBuilder();
        for (AccessibilityNodeInfo n : ns) { String d = desc(n); if (d != null && b.length() < 120) b.append(d.replace('\n', ' ')).append(" | "); }
        return b.toString();
    }
    static String digits(String s) { return s == null ? "" : s.replaceAll("\\D", ""); }
    static long centsOf(String s) { String d = digits(s); if (d.isEmpty()) return -1; try { return Long.parseLong(d); } catch (Exception e) { return -1; } }
    static String last(String s, int n) { return s == null ? "" : s.length() <= n ? s : s.substring(s.length() - n); }
    static String match(String s, String re) { Matcher m = Pattern.compile(re).matcher(s); return m.find() ? m.group(1) : ""; }

    private void clickPrefix(List<AccessibilityNodeInfo> ns, String p) { click(first(ns, n -> startsWith(desc(n), p))); }
    private void clickDesc(List<AccessibilityNodeInfo> ns, String d) { click(first(ns, n -> d.equals(desc(n) == null ? null : desc(n).trim()))); }
    private void click(AccessibilityNodeInfo n) {
        if (n == null) return;
        if (n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        Path p = new Path(); p.moveTo(r.exactCenterX(), r.exactCenterY());
        svc.dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, 60 + rnd.nextInt(60))).build(), null, null);
    }
    private boolean setText(AccessibilityNodeInfo n, String v) {
        if (n == null) return false;
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, v);
        return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
    }

    // ── Red ───────────────────────────────────────────
    interface Cb { void done(JSONObject r); }
    private void post(String path, JSONObject params, Cb cb) {
        try { params.put("orderNo", orderNo); } catch (Exception ignored) { }
        String tok = Store.token(svc);
        Executors.newSingleThreadExecutor().execute(() -> {
            JSONObject r = null;
            try { r = Api.call(tok, path, params); } catch (Exception e) { log.log("red: " + e.getMessage()); }
            JSONObject fr = r;
            h.post(() -> cb.done(fr));
        });
    }
    static JSONObject o(Object... kv) {
        JSONObject j = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) j.put(String.valueOf(kv[i]), kv[i + 1]); } catch (Exception ignored) { }
        return j;
    }
}
