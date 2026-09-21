// =============================================================================
// sluh-period-widget.js -- Scriptable widget for the iPhone Lock Screen
// (also works as a Home Screen widget).
//
// All the logic lives in the API -- https://sluhtime.alvear.cl/api/period.php
// returns a ready-made { display: {title, big, sub}, refreshAt } -- so this
// script just draws three lines of text.
//
// SETUP: see api/README.md. If you can't paste, type the short version from
// that file instead; this fuller one only adds per-family styling.
// =============================================================================

const API = "https://sluhtime.alvear.cl/api/period.php";
const ACCENT = new Color("#c8102e"); // SLUH red

let d;
try {
  const r = new Request(API);
  r.timeoutInterval = 10;
  d = await r.loadJSON();
} catch (e) {
  d = { display: { title: "SLUH period", big: "unavailable", sub: "" } };
}
const x = d.display || { title: "SLUH", big: "", sub: "" };

const family = config.widgetFamily || "accessoryRectangular";
const accessory = family.startsWith("accessory");
const w = new ListWidget();
w.backgroundColor = accessory ? new Color("#000000", 0) : new Color("#ffffff");
w.url = "https://sluhtime.alvear.cl/";

if (family === "accessoryInline") {
  // iOS renders this as a single line next to the clock
  w.addText(x.big ? `${x.title} • ${x.big}` : x.title);
} else if (family === "accessoryCircular") {
  w.addSpacer();
  const a = w.addText((d.period || (d.next && d.next.period) || "•").toString());
  a.font = Font.boldSystemFont(20);
  a.centerAlignText();
  const b = w.addText(x.big.replace(" left", ""));
  b.font = Font.systemFont(9);
  b.centerAlignText();
  b.minimumScaleFactor = 0.6;
  w.addSpacer();
} else {
  const t = w.addText(x.title);
  t.font = Font.mediumSystemFont(accessory ? 12 : 13);
  t.textColor = accessory ? Color.white() : ACCENT;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  w.addSpacer(accessory ? 2 : 4);
  const b = w.addText(x.big);
  b.font = Font.boldSystemFont(accessory ? 17 : 24);
  if (!accessory) b.textColor = new Color("#111111");
  b.lineLimit = 1;
  b.minimumScaleFactor = 0.6;
  if (x.sub) {
    w.addSpacer(accessory ? 1 : 3);
    const s = w.addText(x.sub);
    s.font = Font.systemFont(accessory ? 11 : 12);
    s.textColor = accessory ? Color.white() : Color.gray();
    if (accessory) s.textOpacity = 0.7;
    s.lineLimit = 1;
    s.minimumScaleFactor = 0.7;
  }
}

if (d.refreshAt) w.refreshAfterDate = new Date(d.refreshAt);

if (config.runsInWidget) {
  Script.setWidget(w);
} else if (w.presentAccessoryRectangular) {
  await w.presentAccessoryRectangular();
} else {
  await w.presentMedium();
}
Script.complete();
