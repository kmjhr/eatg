import json
p = r'd:\codex\codex-data\GZ\app\ourtone-style-system\runtime-orchestration-summary.json'
with open(p, 'r', encoding='utf-8') as f:
    text = f.read()
try:
    json.loads(text)
    print('OK')
except json.JSONDecodeError as e:
    print('Error:', e)
    print('pos', e.pos)
    print('line', e.lineno)
    print('col', e.colno)
    print('context:', repr(text[e.pos-100:e.pos+100]))
