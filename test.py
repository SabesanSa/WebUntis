import requests, json, re
from bs4 import BeautifulSoup

cfg = json.load(open('config.json'))
s = requests.Session()
s.headers['User-Agent'] = 'Mozilla/5.0'

# Login
page = s.get('https://dortmund.abitur-online.net/login/index.php', timeout=15)
soup = BeautifulSoup(page.text, 'html.parser')
inp = soup.find('input', {'name': 'logintoken'})
resp = s.post('https://dortmund.abitur-online.net/login/index.php', data={
    'username': cfg['moodle_username'],
    'password': cfg['moodle_password'],
    'logintoken': inp['value'] if inp else '',
    'anchor': ''
}, allow_redirects=True, timeout=15)

# Sesskey holen
m = re.search(r'"sesskey"\s*:\s*"([a-zA-Z0-9]+)"', resp.text)
if not m:
    page2 = s.get('https://dortmund.abitur-online.net/my/', timeout=15)
    m = re.search(r'"sesskey"\s*:\s*"([a-zA-Z0-9]+)"', page2.text)
sesskey = m.group(1) if m else ''
print('sesskey:', sesskey)

# Kurse per AJAX API
r = s.post(
    f'https://dortmund.abitur-online.net/lib/ajax/service.php?sesskey={sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification',
    json=[{"index": 0, "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
           "args": {"offset": 0, "limit": 0, "classification": "all", "sort": "fullname"}}],
    timeout=15
)
print(r.text[:3000])
