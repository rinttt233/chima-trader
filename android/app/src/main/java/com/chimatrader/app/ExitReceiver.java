package com.chimatrader.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.util.Log;

/**
 * Handles the "退出" action of the foreground-service notification.
 *
 * Sends SIGTERM to our own process first: the Node server registers a SIGTERM
 * handler that flushes state.json and exits cleanly. A hard kill follows shortly
 * after as a safety net in case Node does not react.
 */
public class ExitReceiver extends BroadcastReceiver {
    public static final String ACTION_EXIT = "com.chimatrader.app.action.EXIT";
    private static final String TAG = "ChimaTraderExit";

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.i(TAG, "exit requested");
        final int pid = Process.myPid();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Log.i(TAG, "sending SIGTERM so node can flush state");
                    Process.sendSignal(pid, 15);
                } catch (Throwable t) {
                    Log.w(TAG, "SIGTERM failed", t);
                }
                try {
                    Thread.sleep(1500);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
                Log.i(TAG, "killing process " + pid);
                Process.killProcess(pid);
            }
        }, "chima-exit");
        thread.start();
        // Give the shutdown thread a moment before the receiver returns.
        try {
            thread.join(4000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
