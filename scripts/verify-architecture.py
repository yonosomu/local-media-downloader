"""Generate initial SPEC traceability; verify coverage without marking tests passed.

python3 scripts/verify-architecture.py --init-matrices (new files only)
python3 scripts/verify-architecture.py (read-only checks + local JSON report)
"""
from pathlib import Path
import csv
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
SPEC = DOCS / 'SPEC.md'
ENGINE = 't_d2d10038'
BROWSER = 't_8590b0cf'
FIXTURES = 't_ab1783c7'
INTEGRATOR = 't_d897eb97'
FR_AT = {
    'FR-01': [3, 4, 6, 17, 18, 19, 20],
    'FR-02': [4, 6, 8, 18, 19],
    'FR-03': [6, 8, 10, 16, 34],
    'FR-04': [4, 5, 19, 21, 22, 29],
    'FR-05': [6, 7, 8, 9, 10, 11, 12, 19, 20, 22, 28, 34],
    'FR-06': [13, 14, 15, 23, 24, 25, 27],
    'FR-07': [16],
    'FR-08': [23, 24, 25, 26, 27, 33],
    'FR-09': [29, 30],
    'FR-10': [3, 31, 32],
    'FR-11': [31, 33],
}
AT_E = set(range(6, 18)) | {21, 22, 25, 27, 28, 34}
AT_B = {1, 2, 3, 4, 5, 18, 19, 20, 23, 24, 26, 29, 30, 31, 32, 33}
FIELDS = ['id', 'kind', 'requirement', 'spec_line', 'implementation_owner',
          'verification_owner', 'test_ids', 'verification_method',
          'expected_evidence', 'status', 'actual_evidence']


def at_id(n):
    return f'AT-{n:02}'


def make_row(identifier, kind, text, line, owner, tests, method):
    return dict(zip(FIELDS, [identifier, kind, text, f'docs/SPEC.md:{line}', owner,
        INTEGRATOR, ';'.join(tests), method,
        f'docs/evidence/acceptance/{identifier}/chrome.json;'
        f'docs/evidence/acceptance/{identifier}/brave.json',
        'not_checked', '']))


def expected_rows():
    lines = SPEC.read_text().splitlines()
    rows = []
    fr = None
    counters = {}
    dod = 0
    in_dod = False
    for number, line in enumerate(lines, 1):
        match = re.match(r'### (FR-\d{2})\. (.+)', line)
        if match:
            fr = match[1]
            tests = [at_id(n) for n in FR_AT[fr]]
            owner = BROWSER if fr in {'FR-01', 'FR-02', 'FR-09', 'FR-10', 'FR-11'} else ENGINE
            if fr in {'FR-03', 'FR-04', 'FR-08'}:
                owner += ';' + BROWSER
            rows.append(make_row(fr, 'FR', match[2], number, owner, tests,
                'Unit + component + продуктовый сценарий каждого test_ids в Chrome/Brave; '
                'каждую дочернюю FR clause проверить; протокол с фактическим результатом и файлами.'))
            counters[fr] = 0
        elif fr and line.startswith('## '):
            fr = None
        elif fr and (line.startswith('- ') or re.match(r'^\d+\. ', line)):
            counters[fr] += 1
            parent = next(row for row in rows if row['id'] == fr)
            text = re.sub(r'^(?:- |\d+\. )', '', line)
            row = make_row(f'{fr}.{counters[fr]:02}', 'FR-clause', text, number,
                parent['implementation_owner'], parent['test_ids'].split(';'),
                'Отдельный assertion для этой clause в unit/component и соответствующих AT; '
                'подтвердить наблюдаемое поведение, ошибки и отсутствие запрещённых side effects.')
            rows.append(row)
        match = re.match(r'\*\*(GATE-[A-E]):\*\* (.+)', line)
        if match:
            identifier, text = match.groups()
            links = {'GATE-A':[23,24,25], 'GATE-B':[28], 'GATE-C':[8,10],
                     'GATE-D':[20], 'GATE-E':[1,2]}[identifier]
            rows.append(make_row(identifier, 'GATE', text.strip(), number,
                ENGINE+';'+BROWSER, [at_id(n) for n in links],
                'Сохранить код/команду эксперимента и повторить на интегрированной dist в обоих браузерах; '
                'GATE-B: 256MiB/2GiB direct и split-tracks segmented, память всех extension contexts '
                'и отдельно browser downloads; GATE-C: A/V маркеры start/middle/end ≤100ms; '
                'GATE-D: реальные политики/права без cookie extraction. Исторический spike не приёмка.'))
        match = re.match(r'\| (AT-\d{2}) \| (.+?) \| (.+?) \|', line)
        if match:
            identifier, scenario, result = match.groups()
            n = int(identifier[3:])
            owner = ENGINE if n in AT_E else BROWSER if n in AT_B else FIXTURES
            rows.append(make_row(identifier, 'AT', scenario+' → '+result, number,
                owner+';'+FIXTURES, [identifier],
                'Выполнить точный сценарий SPEC §13.2 в Chrome и Brave, записать предусловия, '
                'действия, версии, Shields, реальные результаты и ошибки; '
                'direct SHA-256; remux ffprobe+плеер+seek/markers; '
                'live13/14 ≥15min; AT28 оба пути и memory256MiB/2GiB; '
                'AT35 только фактический установленный эталон и согласованные исключения.'))
        if line.startswith('## 16.'):
            in_dod = True
        elif in_dod and line.startswith('## '):
            in_dod = False
        if in_dod and line.startswith('- [ ] '):
            dod += 1
            rows.append(make_row(f'DOD-{dod:02}', 'DoD', line[6:], number,
                INTEGRATOR if dod <= 9 else FIXTURES+';'+INTEGRATOR,
                [at_id(n) for n in (range(1,35) if dod<=9 else [35])],
                'Финальная сверка точного условия с исходниками/готовой поставкой, '
                'test-report и протоколами обоих браузеров; '
                'DOD09 требует настоящего пользовательского сценария, не отметки агента; '
                'паритетный шлюз отдельный, blocked не approved_exception.'))
    # Preserve requirements outside the labelled FR/AT, including all profiles,
    # permissions, data lifecycle, NFR and delivery. Full section text is retained.
    starts = [(i, line) for i,line in enumerate(lines) if line.startswith('## ') and re.match(r'## \d+\.',line)]
    for pos,(start,title) in enumerate(starts):
        section_match = re.match(r'## (\d+)\.', title)
        assert section_match is not None
        section = int(section_match[1])
        if section in {6,16}:
            continue
        end = starts[pos+1][0] if pos+1<len(starts) else len(lines)
        owner = ENGINE if section in {5,9,11} else BROWSER if section in {7,8,10,12} else INTEGRATOR
        if section in {1,2,17,18}:
            owner = FIXTURES+';'+INTEGRATOR
        rows.append(make_row(f'SPEC-{section:02}', 'section', '\n'.join(lines[start:end]).strip(),
            start+1,owner,[at_id(n) for n in range(1,36)],
            'Проверить ВСЕ нормативные пункты раздела, включая таблицы профилей, '
            '§13.3 допуски duration/AV, §13.4 performance/memory/leak loops, '
            '§15 реальные npm команды. Чеклист по подпунктам приложить к evidence; '
            'для справочного источника отдельно проверить факты/неизвестное, не объявлять runtime pass.'))
    return rows


def initialize(rows):
    target=DOCS/'requirements-matrix.csv'
    parity=DOCS/'parity-matrix.csv'
    if target.exists() or parity.exists():
        raise RuntimeError('Refuse overwriting matrices; read and patch existing rows explicitly')
    with target.open('w',newline='') as out:
        writer=csv.DictWriter(out,fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    with parity.open('w',newline='') as out:
        fields=['id','reference_version','feature','scenario','original_result',
                'target_requirement','implementation_status','test_id','evidence_path','exception_approval']
        writer=csv.DictWriter(out,fieldnames=fields)
        writer.writeheader()
        for row in rows:
            if row['kind']=='FR':
                writer.writerow(dict(zip(fields,[f"PARITY-{row['id']}",'not_measured',row['requirement'],
                    'Сравнить установленный оригинал в обоих изолированных браузерах на одинаковых fixtures',
                    'not_checked',row['id'],'not_checked',row['test_ids'],'',''])))


def main():
    rows=expected_rows()
    if '--init-matrices' in sys.argv:
        initialize(rows)
    with (DOCS/'requirements-matrix.csv').open(newline='') as inp:
        actual=list(csv.DictReader(inp))
    assert len({r['id'] for r in actual})==len(actual),'duplicate IDs'
    expected={r['id']:r for r in rows}
    assert set(expected)=={r['id'] for r in actual},'missing/extra requirements'
    for row in actual:
        for field in FIELDS:
            if field not in {'actual_evidence'}:
                assert row.get(field), (row['id'],field)
        assert row['requirement']==expected[row['id']]['requirement'],row['id']
        assert row['status'] in {'not_checked','implemented','verified','blocked','approved_exception','failed'}
        if row['status']=='verified':
            assert row['actual_evidence'],row['id']
    counts={kind:sum(r['kind']==kind for r in actual) for kind in sorted({r['kind'] for r in actual})}
    assert counts['FR']==11 and counts['GATE']==5 and counts['AT']==35 and counts['DoD']==12,counts
    for path in ['architecture.md','contracts.md','work-ownership.md','requirements-matrix.csv','parity-matrix.csv']:
        assert (DOCS/path).stat().st_size>0,path
    summaries=[]
    for name in ['spikes/001-browser-gates/evidence/browser-results-large.json',
                 'spikes/001-browser-gates/evidence/auth-results.json',
                 'spikes/002-remux-browser/evidence/large-results.json']:
        data=json.loads((ROOT/name).read_text())
        summaries.append({'source':name,'sha256':hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),
            'records':[{k:v for k,v in record.items() if k in {
                'browser','version','chromium','gate','status','mib','sha256','bytes','duration',
                'checks','idleTotal','peakTotal','delta','deltaTotal','scope'}} for record in data]})
    report={'scope':'architecture coverage and historical evidence inspection, NOT product AT execution',
            'spec_sha256':hashlib.sha256(SPEC.read_bytes()).hexdigest(),'counts':counts,
            'total_rows':len(actual),'product_verified_rows':sum(r['status']=='verified' for r in actual),
            'historical_spikes':summaries}
    out=DOCS/'evidence'/'architecture-check.json'
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
