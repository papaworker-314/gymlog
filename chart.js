/* Tiny dependency-free SVG line chart (local file, no CDN). UMD for node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GLChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function niceTicks(min, max, count) {
    if (!(max > min)) { var pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
    var raw = (max - min) / Math.max(1, count - 1);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).filter(function (s) { return s >= raw; })[0];
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
    for (var v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
  }

  function dayNum(s) { var p = s.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; }

  // series: [{name,color,dash,opacity,points:[{x:'YYYY-MM-DD',y:number}]}]
  function line(o) {
    var W = o.width || 358, H = o.height || 220, L = 38, R = 12, T = 12, B = 28;
    var all = [];
    o.series.forEach(function (s) { s.points.forEach(function (p) { all.push(p); }); });
    if (!all.length) return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="데이터 없음"></svg>';
    var ys = all.map(function (p) { return p.y; }), xs = all.map(function (p) { return dayNum(p.x); });
    var ticks = niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 5);
    var y0 = ticks[0], y1 = ticks[ticks.length - 1];
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    function X(d) { return x1 === x0 ? (L + (W - L - R) / 2) : L + (dayNum(d) - x0) / (x1 - x0) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    var g = '';
    ticks.forEach(function (t) {
      g += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/>' +
        '<text class="tick" x="' + (L - 6) + '" y="' + (Y(t) + 4).toFixed(1) + '" text-anchor="end">' + t + '</text>';
    });
    var dates = Array.from(new Set(all.map(function (p) { return p.x; }))).sort();
    var show = dates.length <= 3 ? dates : [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]];
    show.forEach(function (d, i) {
      var anchor = show.length > 1 ? (i === 0 ? 'start' : i === show.length - 1 ? 'end' : 'middle') : 'middle';
      g += '<text class="tick" x="' + X(d).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + esc(d.slice(5)) + '</text>';
    });
    o.series.forEach(function (s) {
      var pts = s.points.slice().sort(function (a, b) { return a.x < b.x ? -1 : 1; });
      if (!pts.length) return;
      var op = s.opacity === undefined ? 1 : s.opacity;
      var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ');
      g += '<g class="series" data-name="' + esc(s.name) + '" opacity="' + op + '">' +
        (pts.length > 1 ? '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round"' + (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>' : '') +
        pts.map(function (p) { return '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="' + (s.dash ? 2.5 : 4) + '" fill="' + s.color + '"><title>' + esc(p.x + ' ' + p.y) + '</title></circle>'; }).join('') +
        '</g>';
    });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || '그래프') + '" preserveAspectRatio="xMidYMid meet">' + g + '</svg>';
  }

  return { line: line, niceTicks: niceTicks };
});
