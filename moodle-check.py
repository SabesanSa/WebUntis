#!/usr/bin/env python3
"""
Moodle-Check: Loggt sich per Session-Cookie ein, erkennt neue Dateien,
lädt sie herunter und speichert sie in Google Drive unter Schule/<Fach>/
"""

import os, re, json, hashlib, io, sys
import requests
from bs4 import BeautifulSoup
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

# ── Konfiguration ─────────────────────────────────────────────────────────────
MOODLE_URL  = "https://dortmund.abitur-online.net"
USERNAME    = os.environ["MOODLE_USERNAME"]
PASSWORD    = os.environ["MOODLE_PASSWORD"]
TG_TOKEN    = os.environ["TELEGRAM_BOT_TOKEN"]
TG_CHAT_ID  = os.environ["TELEGRAM_CHAT_ID"]
SA_JSON     = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
ROOT_FOLDER = os.environ.get("DRIVE_ROOT_FOLDER_ID", "")
KNOWN_FILE  = "moodle_known_files.json"
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]

# ── Kurs-Mapping (exakte Kursnamen aus Moodle) ────────────────────────────────
# None  = überspringen
# str   = Drive-Ordnername

KURS_MAPPING = {
    # ── Informatik (alle überspringen) ────────────────────────────────────────
    "Informatik - Allgemeine Informationen":                None,
    "Material Informatik - dynamische Datenstrukturen":     None,
    "Material Informatik: Algorithmen - Suchen und Sortieren": None,
    "Material Informatik GLOOP (3./4. Sem)":               None,
    "4 KO-IF GK a Kluth 2025/26.2":                        None,

    # ── Sonstiges überspringen ─────────────────────────────────────────────────
    "Cafete":                                               None,
    "Allgemeine Schulforen des Westfalen-Kollegs":          None,

    # ── Französisch (beide Kurse → ein Ordner) ────────────────────────────────
    "4 KO-FA GK a Klee 2025/26.2":                         "Französisch",
    "K_FAGKa-3.13.23.3_KLW":                               "Französisch",

    # ── Physik (nach Lehrer getrennt) ──────────────────────────────────────────
    "4 PH-GK b Ritzenhofen, J 2025/26.2":                  "Physik (Ritzenhofen)",
    "4 Ph Ellermann 26":                                    "Physik (Ellermann)",

    # ── Alle anderen Kurse ────────────────────────────────────────────────────
    "4 EW LK Suerhoff 2025/26":                            "Erziehungswissenschaften",
    "4 K-PL GKa Philosophie Kelbassa":                     "Philosophie",
    "4 KO-M GK2 KOS 2025/26.2":                            "Mathematik",
    "4 KO-D GK 2 Hardt-Bongard, 2027/28.2":               "Deutsch",
    "4. Sem. - Kunst - Bockholt - 25/26":                  "Kunst",
    "4.2 E LK Geshengorin 25/26.2":                        "Englisch",
}

def ordnername(kurs_name: str):
    """Gibt Drive-Ordnernamen zurück, None = überspringen, '?' = unbekannter Kurs."""
    if kurs_name in KURS_MAPPING:
        return KURS_MAPPING[kurs_name]
    # Unbekannte Kurse: trotzdem herunterladen, Ordnername = Kursname bereinigt
    return kurs_name.strip()

# ── Google Drive ──────────────────────────────────────────────────────────────

def drive_service():
    creds = service_account.Credentials.from_service_account_info(
        json.loads(SA_JSON), scopes=DRIVE_SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def finde_oder_erstelle_ordner(drive, name, parent_id):
    safe = name.replace("'", "\\'")
    q = (f"name='{safe}' and mimeType='application/vnd.google-apps.folder' "
         f"and '{parent_id}' in parents and trashed=false")
    treffer = drive.files().list(q=q, fields="files(id)").execute().get("files", [])
    if treffer:
        return treffer[0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]}
    return drive.files().create(body=meta, fields="id").execute()["id"]

def lade_hoch(drive, inhalt, dateiname, mime, ordner_id):
    meta  = {"name": dateiname, "parents": [ordner_id]}
    media = MediaIoBaseUpload(io.BytesIO(inhalt), mimetype=mime, resumable=False)
    drive.files().create(body=meta, media_body=media, fields="id").execute()

# ── Telegram ──────────────────────────────────────────────────────────────────

def telegram(text):
    requests.post(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
        json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "HTML"}
    )

# ── Moodle ────────────────────────────────────────────────────────────────────

def login():
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0"
    page = s.get(f"{MOODLE_URL}/login/index.php")
    soup = BeautifulSoup(page.text, "html.parser")
    inp  = soup.find("input", {"name": "logintoken"})
    resp = s.post(f"{MOODLE_URL}/login/index.php", data={
        "username": USERNAME, "password": PASSWORD,
        "logintoken": inp["value"] if inp else "", "anchor": ""
    }, allow_redirects=True)
    if "loginerrormessage" in resp.text or resp.url.endswith("login/index.php"):
        raise Exception("Login fehlgeschlagen – Zugangsdaten prüfen.")
    print("✅ Moodle-Login erfolgreich", flush=True)
    return s

def hole_kurse(s):
    soup  = BeautifulSoup(s.get(f"{MOODLE_URL}/my/").text, "html.parser")
    kurse = {}
    for a in soup.find_all("a", href=re.compile(r"/course/view\.php\?id=\d+")):
        m = re.search(r"id=(\d+)", a["href"])
        if m:
            kid  = m.group(1)
            name = a.get_text(strip=True)
            if name and len(name) > 2 and kid not in kurse:
                kurse[kid] = name
    print(f"📚 {len(kurse)} Kurse gefunden", flush=True)
    return kurse

def hole_dateien(s, kurs_id):
    soup  = BeautifulSoup(s.get(f"{MOODLE_URL}/course/view.php?id={kurs_id}").text, "html.parser")
    seen, dateien = set(), []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not any(x in href for x in ["/mod/resource/view.php", "/pluginfile.php"]):
            continue
        if href in seen: continue
        seen.add(href)
        dateien.append({"name": a.get_text(strip=True) or href.split("/")[-1], "url": href})
    return dateien

MIME_ENDUNGEN = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
}

def lade_datei(s, url):
    resp = s.get(url, timeout=20, allow_redirects=True)
    mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
    cd   = resp.headers.get("content-disposition", "")
    m    = re.search(r'filename[^;=\n]*=["\']?([^"\';\n]+)', cd)
    name = m.group(1).strip() if m else None
    return resp.content, mime, name

# ── Hauptprogramm ─────────────────────────────────────────────────────────────

def main():
    if not ROOT_FOLDER:
        telegram("❌ DRIVE_ROOT_FOLDER_ID fehlt in GitHub Secrets.")
        return

    bekannte     = json.load(open(KNOWN_FILE)) if os.path.exists(KNOWN_FILE) else {}
    drive        = drive_service()
    ordner_cache = {}
    neue_gesamt  = 0

    try:
        s = login()
    except Exception as e:
        telegram(f"❌ Moodle-Login fehlgeschlagen: {e}")
        return

    kurse = hole_kurse(s)
    if not kurse:
        telegram("⚠️ Moodle: Keine Kurse gefunden.")
        return

    for kurs_id, kurs_name in kurse.items():
        ziel = ordnername(kurs_name)
        if ziel is None:
            print(f"⏭️  Übersprungen: {kurs_name}", flush=True)
            continue

        print(f"🔍 Prüfe: {kurs_name} → {ziel}", flush=True)
        dateien      = hole_dateien(s, kurs_id)
        neue_im_kurs = []

        for datei in dateien:
            key = hashlib.md5(datei["url"].encode()).hexdigest()
            if key in bekannte:
                continue
            try:
                inhalt, mime, echter_name = lade_datei(s, datei["url"])
            except Exception as e:
                print(f"  ⚠️ Download-Fehler {datei['name']}: {e}", flush=True)
                continue

            dateiname = echter_name or datei["name"]
            if not any(dateiname.endswith(ext) for ext in MIME_ENDUNGEN.values()):
                dateiname += MIME_ENDUNGEN.get(mime, "")

            try:
                if ziel not in ordner_cache:
                    ordner_cache[ziel] = finde_oder_erstelle_ordner(drive, ziel, ROOT_FOLDER)
                lade_hoch(drive, inhalt, dateiname, mime, ordner_cache[ziel])
                bekannte[key] = {"name": dateiname, "kurs": ziel}
                neue_im_kurs.append(dateiname)
                print(f"  ✅ {ziel}/{dateiname}", flush=True)
            except Exception as e:
                print(f"  ⚠️ Drive-Fehler {dateiname}: {e}", flush=True)

        if neue_im_kurs:
            liste = "\n".join(f"  📄 {n}" for n in neue_im_kurs)
            telegram(f"📚 <b>Neue Dateien – {ziel}</b>\n{liste}\n\n<i>→ Google Drive: Schule/{ziel}/</i>")
            neue_gesamt += len(neue_im_kurs)

    json.dump(bekannte, open(KNOWN_FILE, "w"), indent=2)
    print(f"✅ Fertig – {neue_gesamt} neue Dateien hochgeladen.", flush=True)

if __name__ == "__main__":
    main()
