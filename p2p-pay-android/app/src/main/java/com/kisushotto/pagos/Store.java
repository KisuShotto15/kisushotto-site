package com.kisushotto.pagos;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Preferencias. La clave de BDV se cifra con una llave del Keystore de Android: nunca sale del telefono. */
final class Store {
    private static final String ALIAS = "kspagos_bdv";
    static SharedPreferences p(Context c) { return c.getSharedPreferences("kspagos", Context.MODE_PRIVATE); }

    static String token(Context c) { return p(c).getString("token", null); }
    static void token(Context c, String t) { p(c).edit().putString("token", t).apply(); }
    static String pkg(Context c) { return p(c).getString("pkg", null); }
    static void pkg(Context c, String v) { p(c).edit().putString("pkg", v).apply(); }
    static boolean paused(Context c) { return p(c).getBoolean("paused", false); }
    static void paused(Context c, boolean v) { p(c).edit().putBoolean("paused", v).apply(); }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return kg.generateKey();
    }
    static void password(Context c, String pw) throws Exception {
        Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
        ci.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = ci.doFinal(pw.getBytes(StandardCharsets.UTF_8));
        p(c).edit().putString("pw_iv", Base64.encodeToString(ci.getIV(), Base64.NO_WRAP))
                .putString("pw_ct", Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
    }
    static boolean hasPassword(Context c) { return p(c).getString("pw_ct", null) != null; }
    static String password(Context c) {
        try {
            String iv = p(c).getString("pw_iv", null), ct = p(c).getString("pw_ct", null);
            if (iv == null || ct == null) return null;
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new String(ci.doFinal(Base64.decode(ct, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }
}
