package com.kisushotto.health.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

// Aviso de fin de descanso (o de una fase con tiempo) cuando la app esta en
// segundo plano: con el telefono bloqueado el WebView no corre el temporizador.
// La web avisa la hora de fin (NativePlugin.timer); la alarma se programa solo al
// ocultarse la app y se cancela al volver, asi con la app abierta no hay doble aviso.
public class TimerAlarm extends BroadcastReceiver {

    static final String CHANNEL = "timer";
    static long at = 0;
    static String title = "", body = "";

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Temporizador", NotificationManager.IMPORTANCE_HIGH));
    }

    private static PendingIntent pending(Context c) {
        Intent i = new Intent(c, TimerAlarm.class).putExtra("title", title).putExtra("body", body);
        return PendingIntent.getBroadcast(c, 7, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // App en segundo plano: programa el aviso si hay una cuenta en curso.
    static void schedule(Context c) {
        if (at <= System.currentTimeMillis() + 500) return;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = pending(c);
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    // App de vuelta al frente: la web sigue la cuenta por su cuenta.
    static void cancel(Context c) {
        c.getSystemService(AlarmManager.class).cancel(pending(c));
        NotificationManagerCompat.from(c).cancel("timer", 0);
    }

    @Override
    public void onReceive(Context c, Intent in) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class).putExtra("url", "/#rutina").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 8, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(0xFF4F86FF)
            .setContentTitle(in.getStringExtra("title"))
            .setContentText(in.getStringExtra("body"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi);
        NotificationManagerCompat.from(c).notify("timer", 0, b.build());
    }
}
