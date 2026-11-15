"""Save the NASA CCMC DONKI records of the 20 May 2024 solar event to data/space_weather/.

DONKI (Space Weather Database Of Notifications, Knowledge, Information) is the record of what
Earth-side space-weather analysts saw and announced. The engine reads the saved file and never
calls the API: the demo does not depend on a live service.

The file keeps the DONKI values unchanged and only drops fields the engine does not use. It holds
  - the coronal mass ejection first seen at 2024-05-20T05:36Z, its analyses and WSA-ENLIL runs,
  - the notifications issued for it,
  - every solar energetic particle (SEP) record in the query window,
so that "no record" is a statement about a query that can be repeated.

Usage:
    python tools/fetch_donki.py            # NASA_API_KEY from the environment, else DEMO_KEY

Credit: NASA Community Coordinated Modeling Center (CCMC), Moon to Mars Space Weather Analysis Office.
"""
import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "space_weather", "donki_2024-05-20.json")
API = "https://api.nasa.gov/DONKI/"
CME_ID = "2024-05-20T05:36:00-CME-001"
DAY = "2024-05-20"
WINDOW = ("2024-05-19", "2024-05-25")          # SEP records searched in this window


def get(endpoint, **query):
    query["api_key"] = os.environ.get("NASA_API_KEY") or "DEMO_KEY"
    url = API + endpoint + "?" + urllib.parse.urlencode(query)
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            body = r.read().decode("utf8")
    except urllib.error.HTTPError as e:                      # never echo the URL: it carries the key
        raise SystemExit("DONKI %s: HTTP %d (429 means the key's hourly limit is used up)" % (endpoint, e.code)) from None
    return json.loads(body) if body.strip() else []          # DONKI answers an empty body when nothing matches


def names(instruments):
    return [i["displayName"] for i in instruments or []]


def main():
    cme = next(c for c in get("CME", startDate=DAY, endDate=DAY) if c["activityID"] == CME_ID)
    analyses = []
    for a in cme["cmeAnalyses"]:
        analyses.append(dict(
            time21_5=a["time21_5"], latitude=a["latitude"], longitude=a["longitude"], halfAngle=a["halfAngle"],
            speed=a["speed"], type=a["type"], featureCode=a["featureCode"], note=a["note"],
            submissionTime=a["submissionTime"], link=a["link"],
            enlil=[dict(modelCompletionTime=e["modelCompletionTime"], au=e["au"], link=e["link"],
                        impactList=e.get("impactList") or []) for e in a.get("enlilList") or []]))
    wanted = {n["messageID"] for n in cme.get("sentNotifications") or []}
    notes = [dict(messageID=n["messageID"], messageType=n["messageType"], messageIssueTime=n["messageIssueTime"],
                  messageURL=n["messageURL"], messageBody=n["messageBody"])
             for n in get("notifications", startDate=DAY, endDate=DAY, type="all") if n["messageID"] in wanted]
    sep = [dict(sepID=s["sepID"], eventTime=s["eventTime"], instruments=names(s.get("instruments")), link=s["link"])
           for s in get("SEP", startDate=WINDOW[0], endDate=WINDOW[1])]
    out = dict(
        note="NASA CCMC DONKI records for the solar event of 20 May 2024, saved once. Values are unchanged; "
             "fields the engine does not use are dropped. Rebuild with tools/fetch_donki.py.",
        source="NASA CCMC DONKI, https://ccmc.gsfc.nasa.gov/tools/DONKI/ (through https://api.nasa.gov/DONKI/)",
        retrieved_utc=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        cme=dict(activityID=cme["activityID"], startTime=cme["startTime"], instruments=names(cme["instruments"]),
                 note=cme["note"], submissionTime=cme["submissionTime"], link=cme["link"], analyses=analyses),
        notifications=notes,
        window=dict(startDate=WINDOW[0], endDate=WINDOW[1]),
        sep=sep,
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.relpath(OUT, ROOT), "| analyses", len(analyses), "| notifications", len(notes),
          "| SEP records", len(sep))


if __name__ == "__main__":
    main()
