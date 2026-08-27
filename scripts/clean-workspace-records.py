import json
import shutil

p = r'C:/Users/15927/.dsh/storages/workspace.json'
shutil.copy(p, p + '.bak')
d = json.load(open(p, encoding='utf-8'))

tables = d['tables']['workspaces']
doomed = {
    wid
    for wid, rec in tables.items()
    if any(k in rec.get('path', '').replace('\\', '/').lower() for k in ('/demo-1', '/demo-2'))
}
for wid in doomed:
    tables.pop(wid)
d['global']['workspaceIds'] = [w for w in d['global']['workspaceIds'] if w not in doomed]

open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
print('removed:', len(doomed), 'records | remaining workspaces:')
for wid in d['global']['workspaceIds']:
    print(' -', tables[wid]['path'] if wid in tables else '(id only)')
