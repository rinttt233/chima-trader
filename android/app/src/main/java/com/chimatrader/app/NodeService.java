package com.chimatrader.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Keeps the embedded Node.js server (nodejs-mobile / libnode.so) running as a
 * foreground service on 127.0.0.1:8787.
 *
 * On start it installs the APK's {@code assets/nodejs-project} into
 * {@code filesDir/nodejs-project} (only when the APK changed) and then calls the
 * native {@code node::Start}. Account data lives in {@code filesDir/data}, which
 * is NOT touched by the asset install, so app upgrades keep every account.
 */
public class NodeService extends Service {
    private static final String TAG = "ChimaTraderNode";
    private static final String CHANNEL_ID = "chima-node-service";
    private static final int NOTIFICATION_ID = 1001;
    private static final String PREFS = "chima_android_prefs";
    private static final String PREF_LAST_UPDATE = "nodejs_project_last_update";

    private static final Object LOCK = new Object();
    private static volatile boolean sNodeStarting = false;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    /** Implemented in src/main/cpp/native-lib.cpp: blocks until Node exits. */
    private static native Integer startNodeWithArguments(String[] arguments);

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // onCreate() already did the work; nothing to restart on redelivery.
        return START_NOT_STICKY;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification("正在启动本地服务…"));
        Log.i(TAG, "service created, launching node thread");

        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File projectDir = installNodeProjectIfNeeded();
                    if (projectDir == null) {
                        updateNotification("本地服务文件缺失");
                        return;
                    }
                    File mainJs = new File(projectDir, "main.js");
                    synchronized (LOCK) {
                        if (sNodeStarting) {
                            Log.i(TAG, "node already starting, skipping duplicate launch");
                            return;
                        }
                        sNodeStarting = true;
                    }
                    Log.i(TAG, "node::Start " + mainJs.getAbsolutePath());
                    Integer code = startNodeWithArguments(new String[]{"node", mainJs.getAbsolutePath()});
                    Log.w(TAG, "node exited: " + code);
                    synchronized (LOCK) {
                        sNodeStarting = false;
                    }
                    updateNotification("本地服务已停止");
                } catch (Throwable t) {
                    Log.e(TAG, "failed to start node", t);
                    synchronized (LOCK) {
                        sNodeStarting = false;
                    }
                    updateNotification("本地服务启动失败");
                }
            }
        }, "chima-node");
        thread.start();
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "service destroyed");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Keep serving data after the user swipes the app away; the notification
        // action is the deliberate "quit" path.
        Log.i(TAG, "task removed, service keeps running");
        super.onTaskRemoved(rootIntent);
    }

    // ------------------------------------------------------------------ assets

    /**
     * Copies assets/nodejs-project into filesDir/nodejs-project when the APK
     * changed. The sibling filesDir/data directory is deliberately outside the
     * copied tree so account state survives upgrades.
     */
    private File installNodeProjectIfNeeded() {
        File projectDir = new File(getFilesDir(), "nodejs-project");
        File dataDir = new File(getFilesDir(), "data");
        try {
            if (!dataDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dataDir.mkdirs();
            }
            long apkUpdateTime = packageUpdateTime();
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            long installedUpdateTime = prefs.getLong(PREF_LAST_UPDATE, 0L);
            boolean missing = !new File(projectDir, "main.js").isFile()
                    || !new File(projectDir, "app.mjs").isFile();
            if (missing || installedUpdateTime != apkUpdateTime) {
                Log.i(TAG, "installing nodejs-project (apk " + installedUpdateTime + " -> " + apkUpdateTime + ")");
                deleteRecursively(projectDir);
                copyAssetFolder(getAssets(), "nodejs-project", projectDir);
                prefs.edit().putLong(PREF_LAST_UPDATE, apkUpdateTime).apply();
                Log.i(TAG, "nodejs-project installed");
            } else {
                Log.i(TAG, "nodejs-project up to date");
            }
            return projectDir;
        } catch (IOException e) {
            Log.e(TAG, "asset install failed", e);
            return null;
        }
    }

    private long packageUpdateTime() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.lastUpdateTime;
        } catch (Exception e) {
            Log.w(TAG, "packageUpdateTime unavailable", e);
            return 1L;
        }
    }

    private static boolean deleteRecursively(File file) {
        if (file == null || !file.exists()) return true;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        return file.delete();
    }

    private static void copyAssetFolder(AssetManager assets, String from, File to) throws IOException {
        String[] children = assets.list(from);
        if (children == null || children.length == 0) {
            copyAssetFile(assets, from, to);
            return;
        }
        if (!to.isDirectory() && !to.mkdirs() && !to.isDirectory()) {
            throw new IOException("cannot create directory " + to);
        }
        for (String child : children) {
            copyAssetFolder(assets, from + "/" + child, new File(to, child));
        }
    }

    private static void copyAssetFile(AssetManager assets, String from, File to) throws IOException {
        File parent = to.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("cannot create directory " + parent);
        }
        InputStream in = null;
        OutputStream out = null;
        try {
            in = assets.open(from);
            out = new FileOutputStream(to);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // nothing useful to do
        }
    }

    // ------------------------------------------------------------ notification

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_description));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private PendingIntent contentIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent, pendingIntentFlags());
    }

    private PendingIntent exitIntent() {
        Intent intent = new Intent(this, ExitReceiver.class);
        intent.setAction(ExitReceiver.ACTION_EXIT);
        return PendingIntent.getBroadcast(this, 1, intent, pendingIntentFlags());
    }

    private static int pendingIntentFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle(getString(R.string.notification_title))
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_chima)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(contentIntent())
                .setPriority(Notification.PRIORITY_LOW)
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this, R.drawable.ic_stat_chima),
                        getString(R.string.notification_action_exit),
                        exitIntent()).build());
        return builder.build();
    }

    private void updateNotification(String text) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
        } catch (Throwable t) {
            Log.w(TAG, "notification update failed", t);
        }
    }
}
