// Small shared helpers for the Desmos-style mockups (I-L).

// The frozen mockup moment: Tuesday, Nov. 10, 2026, 10:40:02 a.m.
var MOCK_DATE = '20261110';
var MOCK_MIN = 10 * 60 + 40 + 2 / 60;   // minutes since midnight

var SVG_NS = 'http://www.w3.org/2000/svg';

// el(svg, 'line', {x1: .., ...}, optionalText) -> appends and returns the element
function el(parent, tag, attrs, text) {
  var e = document.createElementNS(SVG_NS, tag);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent.appendChild(e);
  return e;
}

// A Desmos-style point label: text on a white rounded pill.
function pointLabel(svg, x, y, text, color, anchor) {
  var g = el(svg, 'g', {});
  var t = el(g, 'text', { x: x, y: y, 'text-anchor': anchor || 'start', 'dominant-baseline': 'central',
                          class: 'plabel', fill: color || '#1e2a3a' }, text);
  var b = t.getBBox();
  el(g, 'rect', { x: b.x - 10, y: b.y - 5, width: b.width + 20, height: b.height + 10, rx: 8,
                  fill: '#ffffff', stroke: '#d4d4d4', 'stroke-width': 1.5 });
  g.appendChild(t);   // move the text back on top of its pill
  return g;
}

// Real class days from data.js (days with at least one period), as
// [{date: 'YYYYMMDD', day: Date}] in order.
function classDays() {
  return SCHOOL_YEAR_DATA.filter(function (d) { return d.periods.length > 0; }).map(function (d) {
    return { date: d.date, day: new Date(+d.date.slice(0, 4), +d.date.slice(4, 6) - 1, +d.date.slice(6, 8)) };
  });
}

// "8:25" style label for minutes since midnight (12-hour, no a.m./p.m.)
function clock12(min) {
  var h = Math.floor(min / 60), m = Math.floor(min % 60);
  return ((h + 11) % 12 + 1) + ':' + (m < 10 ? '0' : '') + m;
}
