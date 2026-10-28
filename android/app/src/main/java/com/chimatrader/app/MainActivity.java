package com.chimatrader.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Full-screen WebView pointing at the locally embedded server.
 *
 * Flow: start NodeService -> poll http://127.0.0.1:8787/api/health for up to
 * 30s -> load the UI. No remote server is involved; only public quote APIs are
 * reached by the Node process itself.
 */
public class MainActivity extends Activity {
    private static final String TAG = "ChimaTrader";
    private static final String APP_URL = "http://127.0.0.1:8787/";
    private static final String HEALTH_URL = "http://127.0.0.1:8787/api/health";
    private static final long HEALTH_TIMEOUT_MS = 30000L;
    private static final long HEALTH_RETRY_MS = 400L;
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_NOTIFICATIONS = 1002;

    private WebView webView;
    private View splash;
    private TextView statusText;
    private ProgressBar statusProgress;
    private Button retryButton;

    private ValueCallback<Uri[]> filePathCallback;
    private volatile int pollToken = 0;
    private volatile boolean polling = false;
    private boolean pageLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(Color.parseColor("#0B0E13"));
            getWindow().setNavigationBarColor(Color.parseColor("#0B0E13"));
        }
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.web_view);
        splash = findViewById(R.id.splash);
        statusText = findViewById(R.id.status_text);
        statusProgress = findViewById(R.id.status_progress);
        retryButton = findViewById(R.id.retry_button);

        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.i(TAG, "retry requested");
                startLocalService();
                pageLoaded = false;
                webView.setVisibility(View.GONE);
                splash.setVisibility(View.VISIBLE);
                startHealthPolling();
            }
        });

        configureWebView();
        requestNotificationPermissionIfNeeded();
        startLocalService();
        startHealthPolling();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        // If the UI never loaded (e.g. the service was killed while away), retry.
        if (!pageLoaded && !polling) {
            startLocalService();
            startHealthPolling();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        pollToken += 1;
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ webview

    private void configureWebView() {
        webView.setBackgroundColor(Color.parseColor("#0B0E13"));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String host = uri.getHost();
                if (host != null && (host.equals("127.0.0.1") || host.equals("localhost"))) {
                    return false; // keep the local SPA inside the WebView
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith(APP_URL)) {
                    pageLoaded = true;
                    splash.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame() && !isFinishing()) {
                    pageLoaded = false;
                    CharSequence description = error == null ? "" : error.getDescription();
                    showError(getString(R.string.status_load_failed, description));
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                filePathCallback = callback;
                Intent intent = null;
                if (params != null) {
                    try {
                        intent = params.createIntent();
                    } catch (Exception e) {
                        Log.w(TAG, "createIntent failed", e);
                    }
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_backup_file)),
                            REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "no file chooser available", e);
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, R.string.no_file_chooser, Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                Log.i(TAG, "download: " + url);
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                if (saveWithDownloadManager(url, userAgent, mimeType, fileName)) return;
                saveInApp(url, fileName);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i += 1) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        // Back navigates the SPA first; only leave the app when there is no history.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    // ---------------------------------------------------------------- downloads

    /** Primary path: hand the URL to DownloadManager (system UI + notification). */
    private boolean saveWithDownloadManager(String url, String userAgent, String mimeType, String fileName) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null) request.setMimeType(mimeType);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            request.setTitle(fileName);
            request.setDescription(getString(R.string.download_description));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) return false;
            manager.enqueue(request);
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            Toast.makeText(this, getString(R.string.download_started, fileName, dir == null ? "" : dir.getAbsolutePath()),
                    Toast.LENGTH_LONG).show();
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "DownloadManager failed, falling back to in-app download", t);
            return false;
        }
    }

    /** Fallback for devices where DownloadManager cannot reach 127.0.0.1. */
    private void saveInApp(final String url, final String fileName) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                InputStream in = null;
                OutputStream out = null;
                try {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                        throw new java.io.IOException("cannot create " + dir);
                    }
                    final File target = new File(dir, fileName);
                    connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setConnectTimeout(5000);
                    connection.setReadTimeout(30000);
                    in = new BufferedInputStream(connection.getInputStream());
                    out = new FileOutputStream(target);
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                    out.flush();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this,
                                    getString(R.string.download_saved, target.getAbsolutePath()),
                                    Toast.LENGTH_LONG).show();
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "in-app download failed", e);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this,
                                    getString(R.string.download_failed), Toast.LENGTH_LONG).show();
                        }
                    });
                } finally {
                    closeQuietly(in);
                    closeQuietly(out);
                    if (connection != null) connection.disconnect();
                }
            }
        }, "chima-download").start();
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception ignored) {
            // ignore
        }
    }

    // ------------------------------------------------------------ service start

    private void startLocalService() {
        try {
            Intent intent = new Intent(this, NodeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Throwable t) {
            Log.e(TAG, "cannot start NodeService", t);
            showError(getString(R.string.status_service_failed, String.valueOf(t.getMessage())));
            return;
        }
        keepCpuOnForStartup();
    }

    /**
     * A short wake lock keeps the CPU alive while node boots on a freshly
     * unlocked phone; it is released as soon as the UI is up (see startHealthPolling).
     */
    private void keepCpuOnForStartup() {
        try {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power == null) return;
            PowerManager.WakeLock wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ChimaTrader:startup");
            wakeLock.acquire(60000L);
        } catch (Throwable t) {
            Log.w(TAG, "wake lock failed", t);
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        } catch (Throwable t) {
            Log.w(TAG, "notification permission request failed", t);
        }
    }

    // --------------------------------------------------------------- health poll

    private void startHealthPolling() {
        final int token = ++pollToken;
        polling = true;
        showStarting();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                long deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS;
                boolean ready = false;
                while (System.currentTimeMillis() < deadline) {
                    if (pollToken != token) return;
                    if (isServerUp()) {
                        ready = true;
                        break;
                    }
                    try {
                        Thread.sleep(HEALTH_RETRY_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                final boolean ok = ready;
                if (pollToken != token) return;
                polling = false;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (isFinishing() || pollToken != token) return;
                        if (ok) {
                            splash.setVisibility(View.GONE);
                            webView.setVisibility(View.VISIBLE);
                            if (!pageLoaded) webView.loadUrl(APP_URL);
                        } else {
                            showError(getString(R.string.status_timeout));
                        }
                    }
                });
            }
        }, "chima-health");
        thread.setDaemon(true);
        thread.start();
    }

    private boolean isServerUp() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(HEALTH_URL).openConnection();
            connection.setConnectTimeout(1200);
            connection.setReadTimeout(1200);
            connection.setRequestMethod("GET");
            connection.setUseCaches(false);
            int code = connection.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Throwable t) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ------------------------------------------------------------------ splash UI

    private void showStarting() {
        splash.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        statusProgress.setVisibility(View.VISIBLE);
        retryButton.setVisibility(View.GONE);
        statusText.setText(R.string.status_starting);
    }

    private void showError(String message) {
        splash.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        statusProgress.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        statusText.setText(message);
    }
}
