/* Chart layer for ChimaTrader.
 * Wraps TradingView Lightweight Charts v4 (UMD global window.LightweightCharts).
 * All bar timestamps are shifted to Beijing wall-clock seconds so that the
 * default axis labels match Asia/Shanghai; tooltips use the original ISO time.
 */
(function () {
  'use strict';

  var LWC = window.LightweightCharts;
  if (!LWC) {
    console.error('[charts] LightweightCharts 未加载');
    return;
  }

  var COLORS = {
    up: '#f6465d',
    down: '#16c784',
    grid: '#1a2130',
    border: '#253044',
    text: '#93a1b5',
    panel: '#0b1018',
    crosshair: '#51617a',
    accent: '#3b82f6',
    ma5: '#f0b90b',
    ma10: '#38bdf8',
    ma20: '#e879f9'
  };

  var BEIJING_OFFSET_SEC = 8 * 3600;
  var INTRADAY_MAX_MS = 86400000;
  var dateFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  var timeFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  });

  function toChartTime(iso) {
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000) + BEIJING_OFFSET_SEC;
  }

  function formatBarTime(iso, withTime) {
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return String(iso || '');
    var date = dateFmt.format(new Date(ms)).replace(/\//g, '-');
    return withTime ? date + ' ' + timeFmt.format(new Date(ms)) : date;
  }

  function priceFormat(precision) {
    var p = Math.max(0, Math.min(8, precision));
    return { type: 'price', precision: p, minMove: Math.pow(10, -p) };
  }

  function makePriceFormatter(precision) {
    return function (price) {
      return Number(price).toLocaleString('zh-CN', {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision
      });
    };
  }

  function baseOptions(container, precision) {
    var width = container.clientWidth || 600;
    var height = container.clientHeight || 360;
    return {
      width: width,
      height: height,
      layout: {
        background: { type: 'solid', color: COLORS.panel },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        attributionLogo: false
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid }
      },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: COLORS.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#2b3648' },
        horzLine: { color: COLORS.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#2b3648' }
      },
      rightPriceScale: {
        borderColor: COLORS.border,
        scaleMargins: { top: 0.06, bottom: 0.24 }
      },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 6,
        minBarSpacing: 2,
        fixLeftEdge: false
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: makePriceFormatter(precision != null ? precision : 2)
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    };
  }

  function attachResize(chart, container) {
    function resize() {
      var width = container.clientWidth;
      var height = container.clientHeight;
      if (width > 0 && height > 0) chart.applyOptions({ width: width, height: height });
    }
    if (typeof ResizeObserver !== 'undefined') {
      var pending = false;
      var observer = new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () { pending = false; resize(); });
      });
      observer.observe(container);
      return function () { observer.disconnect(); };
    }
    window.addEventListener('resize', resize);
    return function () { window.removeEventListener('resize', resize); };
  }

  function computeMA(bars, period, intraday) {
    var out = [];
    var sum = 0;
    for (var i = 0; i < bars.length; i++) {
      sum += bars[i].c;
      if (i >= period) sum -= bars[i - period].c;
      if (i >= period - 1) {
        out.push({ time: toChartTime(bars[i].t), value: sum / period });
      }
    }
    return out;
  }

  // ------------------------------------------------------------- price chart

  function createPriceChart(container, options) {
    var opts = options || {};
    var chart = LWC.createChart(container, baseOptions(container, 2));
    var detach = attachResize(chart, container);
    var candleSeries = null;
    var lineSeries = null;
    var volumeSeries = null;
    var maSeries = [];
    var timeIndex = new Map();
    var mode = 'candles';
    var precision = 2;
    var disposed = false;
    var barData = [];
    var currentInterval = '1d';
    var currentIntervalMs = INTRADAY_MAX_MS;

    chart.subscribeCrosshairMove(function (param) {
      if (!opts.onCrosshair) return;
      if (!param || !param.time) {
        opts.onCrosshair(null);
        return;
      }
      var bar = timeIndex.get(param.time) || null;
      var series = mode === 'candles' ? candleSeries : lineSeries;
      var price = null;
      if (series && param.seriesData && param.seriesData.get) {
        var point = param.seriesData.get(series);
        if (point) price = point.close != null ? point.close : point.value;
      }
      opts.onCrosshair({ time: param.time, bar: bar, price: price });
    });

    function removeSeries(series) {
      if (!series) return;
      try { chart.removeSeries(series); } catch (e) { /* already removed */ }
    }

    function clearSeries() {
      removeSeries(candleSeries);
      removeSeries(lineSeries);
      removeSeries(volumeSeries);
      maSeries.forEach(function (entry) { removeSeries(entry.series); });
      candleSeries = null;
      lineSeries = null;
      volumeSeries = null;
      maSeries = [];
      timeIndex = new Map();
      barData = [];
    }

    function applyPrecision(value) {
      precision = value != null ? value : 2;
      chart.applyOptions({ localization: { priceFormatter: makePriceFormatter(precision) } });
    }

    function setData(payload) {
      if (disposed) return;
      var bars = (payload && payload.bars) || [];
      mode = payload && payload.mode === 'line' ? 'line' : 'candles';
      applyPrecision(payload && payload.precision);
      clearSeries();

      var interval = (payload && payload.interval) || '1d';
      var intervalMs = payload && payload.intervalMs ? payload.intervalMs : intervalToMs(interval);
      var intraday = intervalMs < INTRADAY_MAX_MS;
      currentInterval = interval;
      currentIntervalMs = intervalMs;
      chart.applyOptions({
        timeScale: { timeVisible: intraday, secondsVisible: false },
        localization: {
          timeFormatter: function (time) {
            var iso = new Date((time - BEIJING_OFFSET_SEC) * 1000).toISOString();
            return formatBarTime(iso, intraday);
          }
        }
      });

      if (!bars.length) {
        chart.timeScale().fitContent();
        return;
      }

      var fmt = priceFormat(precision);
      var candleData = [];
      var lineData = [];
      var volumeData = [];
      barData = [];
      for (var i = 0; i < bars.length; i++) {
        var bar = bars[i];
        var time = toChartTime(bar.t);
        if (time == null) continue;
        barData.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 });
        timeIndex.set(time, barData[barData.length - 1]);
        candleData.push({ time: time, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
        lineData.push({ time: time, value: bar.c });
        volumeData.push({
          time: time,
          value: bar.v || 0,
          color: bar.c >= bar.o ? 'rgba(246, 70, 93, 0.45)' : 'rgba(22, 199, 132, 0.45)'
        });
      }

      volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volumeSeries.setData(volumeData);

      if (mode === 'line') {
        lineSeries = chart.addAreaSeries({
          lineColor: COLORS.accent,
          topColor: 'rgba(59, 130, 246, 0.28)',
          bottomColor: 'rgba(59, 130, 246, 0.02)',
          lineWidth: 2,
          priceFormat: fmt,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerRadius: 3
        });
        lineSeries.setData(lineData);
      } else {
        candleSeries = chart.addCandlestickSeries({
          upColor: COLORS.up,
          downColor: COLORS.down,
          borderUpColor: COLORS.up,
          borderDownColor: COLORS.down,
          wickUpColor: COLORS.up,
          wickDownColor: COLORS.down,
          priceFormat: fmt,
          priceLineVisible: false
        });
        candleSeries.setData(candleData);

        var periods = [5, 10, 20];
        var colors = [COLORS.ma5, COLORS.ma10, COLORS.ma20];
        for (var p = 0; p < periods.length; p++) {
          var ma = chart.addLineSeries({
            color: colors[p],
            lineWidth: 1,
            priceFormat: fmt,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          });
          var values = computeMA(barData, periods[p]);
          if (values.length) ma.setData(values);
          maSeries.push({ period: periods[p], series: ma });
        }
      }

      chart.timeScale().fitContent();
      if (barData.length > 180) {
        chart.timeScale().setVisibleLogicalRange({ from: barData.length - 150, to: barData.length + 2 });
      }
    }

    function updateMALastValue() {
      if (mode !== 'candles' || !barData.length) return;
      var lastTime = toChartTime(barData[barData.length - 1].t);
      if (lastTime == null) return;
      for (var i = 0; i < maSeries.length; i++) {
        var period = maSeries[i].period;
        if (barData.length < period) continue;
        var sum = 0;
        for (var j = barData.length - period; j < barData.length; j++) sum += barData[j].c;
        maSeries[i].series.update({ time: lastTime, value: sum / period });
      }
    }

    // The chart can be left open across sessions/holidays. When the newest live
    // quote is far beyond the last stored bar we must refetch instead of
    // fabricating bars, otherwise the axis gets a huge empty gap.
    var reloadAskedAt = 0;
    function askReload(reason) {
      var now = Date.now();
      if (now - reloadAskedAt < 30000) return;
      reloadAskedAt = now;
      if (typeof opts.onNeedReload === 'function') {
        try { opts.onNeedReload(reason); } catch (e) { /* noop */ }
      }
    }

    // Streaming update: only touch the last candle/point (or append one new bar
    // when the quote's own timestamp rolls over), never re-render the chart.
    // Uses the QUOTE timestamp, never the local wall clock: a closed market must
    // not append fake bars while the page sits there with stale quotes.
    function updateQuote(quote) {
      if (disposed || !quote || !barData.length) return;
      if (quote.stale === true) return;
      var price = Number(quote.price);
      if (!isFinite(price)) return;
      var quoteMs = Date.parse(quote.ts);
      if (!isFinite(quoteMs)) return;
      var now = Date.now();
      var intervalMs = currentIntervalMs;
      var intraday = intervalMs < INTRADAY_MAX_MS;
      // Ignore quotes that are older than the chart's interval allows (market
      // closed / vendor cache); they must not paint the chart.
      if (now - quoteMs > Math.max(3 * intervalMs, 5 * 60 * 1000)) return;
      var quoteSec = Math.floor(quoteMs / 1000) + BEIJING_OFFSET_SEC;

      var last = barData[barData.length - 1];
      var lastTime = toChartTime(last.t);
      if (lastTime == null) return;

      var stepSec = null;
      if (intraday) {
        stepSec = Math.max(1, Math.round(intervalMs / 1000));
      } else if (currentInterval === '1d') {
        stepSec = 86400;
      }

      if (stepSec != null) {
        var bucket = Math.floor(quoteSec / stepSec) * stepSec;
        if (bucket < lastTime) return; // out-of-order quote: never rewrite history
        if (bucket > lastTime) {
          if (bucket - lastTime > stepSec * 2) {
            askReload('gap'); // weekend / holiday / resumed session
            return;
          }
          var iso = new Date((bucket - BEIJING_OFFSET_SEC) * 1000).toISOString();
          var appended = { t: iso, o: price, h: price, l: price, c: price, v: 0 };
          barData.push(appended);
          timeIndex.set(bucket, appended);
          if (mode === 'candles' && candleSeries) {
            candleSeries.update({ time: bucket, open: price, high: price, low: price, close: price });
          } else if (mode === 'line' && lineSeries) {
            lineSeries.update({ time: bucket, value: price });
          }
          if (candleSeries) updateMALastValue();
          return;
        }
      }

      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      if (mode === 'candles' && candleSeries) {
        candleSeries.update({
          time: lastTime, open: last.o, high: last.h, low: last.l, close: last.c
        });
        updateMALastValue();
      } else if (mode === 'line' && lineSeries) {
        lineSeries.update({ time: lastTime, value: price });
      }
    }

    function destroy() {
      disposed = true;
      detach();
      try { chart.remove(); } catch (e) { /* noop */ }
    }

    var handle = {
      setData: setData,
      updateQuote: updateQuote,
      destroy: destroy,
      chart: chart,
      resize: function () { chart.applyOptions({}); },
      lastBarTime: function () { return barData.length ? barData[barData.length - 1].t : null; },
      barCount: function () { return barData.length; }
    };
    if (typeof window !== 'undefined') {
      window.__charts = window.__charts || [];
      window.__charts.push(handle);
    }
    return handle;
  }

  // ------------------------------------------------------------ equity chart

  function createEquityChart(container, options) {
    var opts = options || {};
    var chart = LWC.createChart(container, baseOptions(container, 2));
    var detach = attachResize(chart, container);
    var areaSeries = null;
    var pointIndex = new Map();
    var disposed = false;

    chart.applyOptions({
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.12, bottom: 0.1 } },
      localization: { priceFormatter: makePriceFormatter(2) }
    });

    chart.subscribeCrosshairMove(function (param) {
      if (!opts.onCrosshair) return;
      if (!param || !param.time) { opts.onCrosshair(null); return; }
      var point = pointIndex.get(param.time) || null;
      var value = null;
      if (areaSeries && param.seriesData && param.seriesData.get) {
        var data = param.seriesData.get(areaSeries);
        if (data) value = data.value;
      }
      opts.onCrosshair({ time: param.time, point: point, value: value });
    });

    function setData(points, range) {
      if (disposed) return;
      var list = points || [];
      applyRange(range);
      if (areaSeries) {
        try { chart.removeSeries(areaSeries); } catch (e) { /* noop */ }
        areaSeries = null;
      }
      pointIndex = new Map();
      var data = [];
      for (var i = 0; i < list.length; i++) {
        var time = toChartTime(list[i].t);
        if (time == null) continue;
        pointIndex.set(time, list[i]);
        data.push({ time: time, value: list[i].equity });
      }
      areaSeries = chart.addAreaSeries({
        lineColor: COLORS.accent,
        topColor: 'rgba(59, 130, 246, 0.30)',
        bottomColor: 'rgba(59, 130, 246, 0.02)',
        lineWidth: 2,
        priceFormat: priceFormat(2),
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 3
      });
      areaSeries.setData(data);
      chart.timeScale().fitContent();
    }

    function applyRange(range) {
      var intraday = range === '1d' || range === '1w';
      chart.applyOptions({
        timeScale: { timeVisible: intraday, secondsVisible: false },
        localization: {
          timeFormatter: function (time) {
            var iso = new Date((time - BEIJING_OFFSET_SEC) * 1000).toISOString();
            return formatBarTime(iso, intraday);
          }
        }
      });
    }

    function destroy() {
      disposed = true;
      detach();
      try { chart.remove(); } catch (e) { /* noop */ }
    }

    var handle = { setData: setData, destroy: destroy, chart: chart };
    if (typeof window !== 'undefined') {
      window.__charts = window.__charts || [];
      window.__charts.push(handle);
    }
    return handle;
  }

  var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '60m': 3600000, '1h': 3600000, '4h': 14400000,
    '1d': 86400000, '1w': 604800000, '1M': 2592000000
  };

  function intervalToMs(interval) {
    return INTERVAL_MS[interval] || 86400000;
  }

  window.Charts = {
    createPriceChart: createPriceChart,
    createEquityChart: createEquityChart,
    intervalToMs: intervalToMs,
    formatBarTime: formatBarTime,
    toChartTime: toChartTime,
    colors: COLORS
  };
})();
