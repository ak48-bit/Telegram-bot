import requests, re, sys
sys.stdout.reconfigure(encoding='utf-8')
session = requests.Session()
session.headers.update({'User-Agent': 'Mozilla/5.0'})
r = session.get('https://www.123bet2bo.com/31207', timeout=10)
html = r.text
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
script = scripts[0]
print(script)
