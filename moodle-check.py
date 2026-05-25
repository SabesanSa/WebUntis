#!/usr/bin/env python3
"""
Moodle-Check: Loggt sich per Session-Cookie ein, erkennt neue Dateien,
lädt sie herunter und speichert sie in Google Drive unter Schule/<Fach>/
"""

import os
import re
import json
import hashlib
import io
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

# ── Kurs-Regeln ───────────────────────────────────────────────────────────────

# Kurse die NICHT heruntergeladen werden (Teilstring reicht)
SKIP_KURSE = [
    "informatik",
    "französisch",
    "franzoesisch",
    "franz",
]

# Kurse die in einen gemeinsamen Ordner zusammengeführt werden
# Format: "Teilstring im Kursnamen (lowercase)" -> "Ordnername in Drive"
MERGE_KURSE = {
    "französisch": "Französisch",
    "franzoesisch": "Französisch",
    "franz":        "Französisch",
}

# Kurse bei denen mehrere Instanzen existieren und benannt werden sollen
# Schlüssel: Teilstring (lowercase), Wert: Präfix für Nummerierung
MULTI_KURSE = {
    "physik": "Physik",
}

# ── Kursname normalisieren ────────────────────────────────────────────────────

# Merkt sich welche Multi-Kurs-Nummer schon vergeben wurde
_multi_zaehler = {}
# Merkt sich kurs_id -> Drive-Ordnername
_kurs_ordner_namen = {}

def ordnername_fuer_kurs(kurs_id: str, kurs_name: str) -> str | None:
    """
    Gibt den Drive-Ordnernamen zurück, oder None wenn der Kurs übersprungen wird.
    Behandelt Merges (Französisch) und Nummerierung (Physik I, II).
    """
    name_lower = kurs_name.lower()

    # Bereits verarbeitet?
    if kurs_id in _kurs_ordner_namen:
        return _kurs_ordner_namen[kurs_id]

    # Überspringen?
    for skip in SKIP_KURSE:
        if skip in name_lower:
            _kurs_ordner_namen[kurs_id] = None
            return None

    # Merge-Kurse (z.B. Französisch I + II → ein Ordner)
    for muster, zielname in MERGE_KURSE.items():
        if muster in name_lower:
            _kurs_ordner_namen[kurs_id] = zielname
            return zielname

    # Multi-Kurse mit Nummerierung (z.B. Physik I, Physik II)
    for muster, praefix in MULTI_KURSE.items():
        if muster in name_lower:
            # Lehrernamen aus dem Kursnamen extrahieren (oft in Klammern oder nach "-")
            lehrer = _extrahiere_lehrer(kurs_name)
            if lehrer:
                ordner = f"{praefix} ({lehrer})"
            else:
                # Sequenziell nummerieren
                n = _multi_zaehler.get(praefix, 0) + 1
                _multi_zaehler[praefix] = n
                roemisch = ["I", "II", "III", "IV", "V"]
                ordner = f"{praefix} {roemisch[n-1] if n <= 5 else str(n)}"
            _kurs_ordner_namen[kurs_id] = ordner
            return ordner

    # Normaler Kurs – Kursnamen aufräumen
    bereinigt = _bereinige_name(kurs_name)
    _kurs_ordner_namen[kurs_id] = bereinigt
    return bereinigt

def _extrahiere_lehrer(kurs_name: str) -> str:
    """Versucht einen Lehrernamen aus dem Kursnamen zu extrahieren."""
    # Muster: "Physik - Müller", "Physik (Müller)", "Physik Müller"
    m = re.search(r'[-–(]\s*([A-ZÄÖÜ][a-zäöüß]+)\s*\)?$', kurs_name)
    if m:
        return m.group(1)
    # Muster: letztes Wort wenn es wie ein Name aussieht
    teile = kurs_name.split()
    if len(teile) >= 2:
        letztes = teile[-1].strip("()")
        if letztes[0].isupper() and len(letztes) > 2:
            return letztes
    return ""

def _bereinige_name(name: str) -> str:
    """Entfernt überflüssige Zusätze aus Kursnamen."""
    # Typische Moodle-Zusätze entfernen
    name = re.sub(r'\s*[-–]\s*(20\d\d|WS|SS|Kurs\s*\d+)\s*$', '', name, flags=re.IGNORECASE)
    return name.strip()

# ── Google Drive ──────────────────────────────────────────────────────────────

def drive_service():
    info = json.loads(SA_JSON)
    creds = service_account.Credentials.from_service_account_info(info, scopes=DRIVE_SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def finde_oder_erstelle_ordner(drive, name, parent_id):
    name_escaped = name.replace("'", "\\'")
    q = (f"name='{name_escaped}' and mimeType='application/vnd.google-apps.folder' "
         f"and '{parent_id}' in parents and trashed=false")
    result = drive.files().list(q=q, fields="files(id)").execute()
    treffer = result.get("files", [])
    if treffer:
        return treffer[0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]}
    return drive.files().create(body=meta, fields="id").execute()["id"]

def lade_hoch(drive, inhalt: bytes, dateiname: str, mime: str, ordner_id: str):
    meta = {"name": dateiname, "parents": [ordner_id]}
    media = MediaIoBaseUpload(io.BytesIO(inhalt), mimetype=mime, resumable=False)
    drive.files().create(body=meta, media_body=media, fields="id").execute()

# ── Hilfsfunktionen ───────────────────────────────────────────────────────────

def lade_bekannte():
    if os.path.exists(KNOWN_FILE):
        with open(KNOWN_FILE) as f:
            return json.load(f)
    return {}

def speichere_bekannte(daten):
    with open(KNOWN_FILE, "w") as f:
        json.dump(daten, f, indent=2)

def sende_telegram(text):
    requests.post(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
        json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "HTML"}
    )

# ── Moodle Login ──────────────────────────────────────────────────────────────

def login():
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0"
    page = s.get(f"{MOODLE_URL}/login/index.php")
    soup = BeautifulSoup(page.text, "html.parser")
    inp = soup.find("input", {"name": "logintoken"})
    logintoken = inp["value"] if inp else ""
    resp = s.post(f"{MOODLE_URL}/login/index.php", data={
        "username": USERNAME, "password": PASSWORD,
        "logintoken": logintoken, "anchor": ""
    }, allow_redirects=True)
    if "loginerrormessage" in resp.text or resp.url.endswith("login/index.php"):
        raise Exception("Login fehlgeschlagen – Zugangsdaten prüfen.")
    print("✅ Moodle-Login erfolgreich")
    return s

# ── Kurse & Dateien ───────────────────────────────────────────────────────────

def hole_kurse(s):
    soup = BeautifulSoup(s.get(f"{MOODLE_URL}/my/").text, "html.parser")
    kurse = {}
    for a in soup.find_all("a", href=re.compile(r"/course/view\.php\?id=\d+")):
        m = re.search(r"id=(\d+)", a["href"])
        if m:
            kid = m.group(1)
            name = a.get_text(strip=True)
            if name and len(name) > 2 and kid not in kurse:
                kurse[kid] = name
    print(f"📚 {len(kurse)} Kurse gefunden")
    return kurse

def hole_dateien(s, kurs_id):
    soup = BeautifulSoup(s.get(f"{MOODLE_URL}/course/view.php?id={kurs_id}").text, "html.parser")
    dateien = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not any(x in href for x in ["/mod/resource/view.php", "/pluginfile.php"]):
            continue
        if href in seen:
            continue
        seen.add(href)
        name = a.get_text(strip=True) or href.split("/")[-1]
        dateien.append({"name": name, "url": href})
    return dateien

def lade_datei(s, url):
    resp = s.get(url, timeout=20, allow_redirects=True)
    mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
    cd = resp.headers.get("content-disposition", "")
    m = re.search(r'filename[^;=\n]*=["\']?([^"\';\n]+)', cd)
    echter_name = m.group(1).strip() if m else None
    return resp.content, mime, echter_name

# ── Hauptprogramm ─────────────────────────────────────────────────────────────

MIME_ENDUNGEN = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
}

def main():
    if not ROOT_FOLDER:
        sende_telegram("❌ Moodle-Check: DRIVE_ROOT_FOLDER_ID fehlt. Bitte in GitHub Secrets eintragen.")
        return

    bekannte = lade_bekannte()
    drive = drive_service()
    # Ordner-ID-Cache (Drive-Ordnername → ID)
    ordner_cache = {}
    neue_gesamt = 0

    try:
        s = login()
    except Exception as e:
        sende_telegram(f"❌ Moodle-Login fehlgeschlagen: {e}")
        return

    kurse = hole_kurse(s)
    if not kurse:
        sende_telegram("⚠️ Moodle: Keine Kurse gefunden.")
        return

    for kurs_id, kurs_name in kurse.items():
        ordner_name = ordnername_fuer_kurs(kurs_id, kurs_name)

        if ordner_name is None:
            print(f"⏭️  Übersprungen: {kurs_name}")
            continue

        dateien = hole_dateien(s, kurs_id)
        neue_im_kurs = []

        for datei in dateien:
            key = hashlib.md5(datei["url"].encode()).hexdigest()
            if key in bekannte:
                continue

            try:
                inhalt, mime, echter_name = lade_datei(s, datei["url"])
            except Exception as e:
                print(f"⚠️ Download-Fehler {datei['name']}: {e}")
                continue

            dateiname = echter_name or datei["name"]
            hat_endung = any(dateiname.endswith(e) for e in MIME_ENDUNGEN.values())
            if not hat_endung:
                dateiname += MIME_ENDUNGEN.get(mime, "")

            try:
                if ordner_name not in ordner_cache:
                    ordner_cache[ordner_name] = finde_oder_erstelle_ordner(drive, ordner_name, ROOT_FOLDER)
                lade_hoch(drive, inhalt, dateiname, mime, ordner_cache[ordner_name])
                bekannte[key] = {"name": dateiname, "kurs": ordner_name}
                neue_im_kurs.append(dateiname)
                print(f"✅ {ordner_name}/{dateiname}")
            except Exception as e:
                print(f"⚠️ Drive-Fehler {dateiname}: {e}")
                continue

        if neue_im_kurs:
            liste = "\n".join(f"  📄 {n}" for n in neue_im_kurs)
            sende_telegram(
                f"📚 <b>Neue Dateien – {ordner_name}</b>\n{liste}\n\n"
                f"<i>→ Google Drive: Schule/{ordner_name}/</i>"
            )
            neue_gesamt += len(neue_im_kurs)

    speichere_bekannte(bekannte)
    print(f"✅ Fertig – {neue_gesamt} neue Dateien hochgeladen.")

if __name__ == "__main__":
    main()
