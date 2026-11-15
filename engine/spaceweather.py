"""Solar storm detection: the on-site rule that raises the alert, and the Earth-side record of the same event.

Two sources, kept apart:

  on site     A rule on the dose rate at the crew's position: alert when the rate is nowcastPct percent
              above the background. This is what fires the solar particle incident. The threshold is the
              one used by the RAD nowcast of Loewe et al. 2025 (arXiv:2502.02469); the rule here is a
              simplified form of it, run on the engine's modelled dose rate.

  Earth side  What NASA CCMC DONKI holds for the storm the scenario replays (20 May 2024), saved in
              data/space_weather/ by tools/fetch_donki.py. It is shown next to the alert as evidence of
              how late and how incomplete a warning from Earth was for a crew on Mars that day. It never
              triggers anything.
"""
import datetime
import json
import os

from . import DATA
from .params import PARAMS

RECORD = os.path.join(DATA, "space_weather", "donki_2024-05-20.json")
NOWCAST_SRC = "Simplified from the RAD nowcast of Loewe et al. 2025, arXiv:2502.02469"
DONKI = "NASA CCMC DONKI"


def threshold():
    """Dose rate (uGy/h, unshielded) at which the on-site rule trips."""
    return PARAMS["gcrRate"] * (1.0 + PARAMS["nowcastPct"] / 100.0)


def tripped(rate_open):
    return rate_open >= threshold() - 1e-9


def delay_s():
    """Seconds from storm onset until the idealised storm profile crosses the threshold; None if it never does."""
    tp = PARAMS["sepPeakMin"] * 60.0
    td = PARAMS["sepDecayH"] * 3600.0
    peak = PARAMS["sepTotal"] / ((tp / 2 + td) / 3600.0)           # same profile as walk.sep_rate
    excess = threshold() - PARAMS["gcrRate"]
    if peak <= excess:
        return None
    return tp * excess / peak


def _utc(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=datetime.timezone.utc)


def _show(s):
    return _utc(s).strftime("%d %b %Y %H:%M UTC").lstrip("0")


def load_record(path=RECORD):
    """The saved DONKI record, or None when the file is missing or unreadable (the engine runs without it)."""
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def earth_side(rec):
    """Facts from the DONKI record as {label, value, unit, kind, source, url} rows."""
    if not rec:
        return []
    cme = rec["cme"]
    rows = [dict(label="Coronal mass ejection first seen", value=_show(cme["startTime"]), unit="", kind="measured",
                 source="%s, CME %s (%s)" % (DONKI, cme["activityID"], ", ".join(cme["instruments"])), url=cme["link"])]
    fast = max(cme["analyses"], key=lambda a: a["speed"])
    rows.append(dict(label="Speed of its shock front", value=fast["speed"], unit="km/s", kind="measured",
                     source="%s CME analysis, fit to SOHO and STEREO A coronagraph images" % DONKI, url=fast["link"]))
    notes = sorted(rec.get("notifications") or [], key=lambda n: n["messageIssueTime"])
    if notes:
        n = notes[0]
        late_h = (_utc(n["messageIssueTime"]) - _utc(cme["startTime"])).total_seconds() / 3600.0
        rows.append(dict(label="First notification issued", value=_show(n["messageIssueTime"]), unit="", kind="measured",
                         source="%s notification %s" % (DONKI, n["messageID"]), url=n["messageURL"]))
        rows.append(dict(label="Notification came after the first sighting by", value=round(late_h, 1), unit="h", kind="measured",
                         source="Difference of the two DONKI times above", url=n["messageURL"]))
    runs = [e for a in cme["analyses"] for e in a["enlil"]]
    hit = sorted({i["location"] for e in runs for i in e["impactList"]})
    rows.append(dict(label="Mars in the predicted impacts", value="yes" if "Mars" in hit else "no", unit="", kind="model",
                     source="%s, %d WSA-ENLIL runs for this CME; predicted impacts: %s" % (DONKI, len(runs), ", ".join(hit) or "none"),
                     url=runs[0]["link"] if runs else cme["link"]))
    w = rec.get("window") or {}
    rows.append(dict(label="Particle event records in DONKI that week", value=len(rec.get("sep") or []), unit="", kind="measured",
                     source="%s SEP records, %s to %s" % (DONKI, w.get("startDate", "?"), w.get("endDate", "?")),
                     url="https://ccmc.gsfc.nasa.gov/tools/DONKI/"))
    return rows


def earth_summary(rec):
    """One sentence on what the Earth-side record means for a crew at Mars; empty without a record."""
    if not rec:
        return ""
    cme = rec["cme"]
    notes = sorted(rec.get("notifications") or [], key=lambda n: n["messageIssueTime"])
    hit = {i["location"] for a in cme["analyses"] for e in a["enlil"] for i in e["impactList"]}
    parts = []
    if notes:
        late_h = (_utc(notes[0]["messageIssueTime"]) - _utc(cme["startTime"])).total_seconds() / 3600.0
        parts.append("the first notification came %.1f h after the eruption was first seen" % late_h)
    parts.append("Mars was %s the predicted impacts" % ("among" if "Mars" in hit else "not among"))
    return "From Earth, " + " and ".join(parts) + "."


def detection(onset_t, alert_t, reading, rec):
    """The `detection` block of a solar particle incident message."""
    return dict(
        method="On-site dose-rate rule",
        rule="Alert when the dose rate is %g%% above the background" % PARAMS["nowcastPct"],
        source=NOWCAST_SRC,
        onset_t=round(onset_t, 1), alert_t=round(alert_t, 1), delay_s=round(alert_t - onset_t, 1),
        readings=[
            dict(label="Background dose rate", value=PARAMS["gcrRate"], unit="uGy/h", kind="measured",
                 source="Hassler et al. 2014, Science 343 (Curiosity RAD, Gale crater)"),
            dict(label="Alert threshold", value=round(threshold(), 2), unit="uGy/h", kind="requirement", source=NOWCAST_SRC),
            dict(label="Dose rate at the alert", value=round(reading, 2), unit="uGy/h", kind="model",
                 source="Engine dose-rate model in the open; not a reading from a real dosimeter"),
            dict(label="Storm onset to alert", value=round(alert_t - onset_t, 1), unit="s", kind="model",
                 source="Time for the modelled storm profile to cross the threshold"),
        ],
        replay="Storm profile: replay of the 20 May 2024 event at Mars, idealised (scenario).",
        earth=earth_side(rec),
        earth_summary=earth_summary(rec),
        earth_note="What Earth-side monitoring recorded for the same event. Shown for context; it does not trigger the alert.",
    )
