#!/usr/bin/env python3
"""Release a reviewed branch: rebase on origin/main, bump VERSION (next minor), add the player-facing "What's new"
entry, merge its PR (squash) and wait until the Pages deploy serves the new version.

  python3 tools/release.py BRANCH "Sentence for players." ["Another sentence." ...]

Run it from a checkout of BRANCH (any worktree). It needs gh (logged in) and node. Every sentence is shown in the
in-game "What's new" popup, so write them for an 8-year-old: what they can see or do now.
"""
import json, re, subprocess, sys, time, urllib.request

SITE = 'https://anielsud.github.io/skywright/src/version.js'


def sh(cmd, check=True):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f'✗ {cmd}\n{r.stdout}{r.stderr}')
    return r.stdout.strip()


def at_least(live, ver):  # live version >= ver, as numbers ('?' when unreadable: no)
    try:
        return tuple(map(int, live.split('.'))) >= tuple(map(int, ver.split('.')))
    except ValueError:
        return False


def js_str(s):
    return json.dumps(s, ensure_ascii=False)  # a double-quoted JS string literal


def main():
    if len(sys.argv) < 3 or not all(a.strip() for a in sys.argv[2:]):
        sys.exit(__doc__)
    branch, items = sys.argv[1], [a.strip() for a in sys.argv[2:]]
    sh('git fetch -q origin')
    # run from the branch's own checkout: from anywhere else the push below would replace the PR's work with HEAD
    if (cur := sh('git branch --show-current')) != branch:
        sys.exit(f'✗ this checkout is on {cur or "a detached HEAD"}, not {branch}: run from a checkout of {branch}')
    if subprocess.run('git merge-base --is-ancestor origin/main HEAD', shell=True).returncode:
        sh('git rebase origin/main')
    if not sh('git rev-list origin/main..HEAD'):
        sys.exit(f'✗ {branch} has no changes beyond origin/main: nothing to release')
    main_ver = re.search(r"VERSION = '(\d+)\.(\d+)\.(\d+)'", sh('git show origin/main:src/version.js')).groups()
    ver = f'{main_ver[0]}.{int(main_ver[1]) + 1}.0'
    v = open('src/version.js').read()
    open('src/version.js', 'w').write(re.sub(r"VERSION = '[^']*'", f"VERSION = '{ver}'", v, count=1))
    c = open('src/changelog.js').read()
    entry = f"  {{ v: '{ver}', items: [\n" + ''.join(f'    {js_str(t)},\n' for t in items) + '  ] },\n'
    c = c.replace('export const CHANGELOG = [\n', 'export const CHANGELOG = [\n' + entry, 1)
    open('src/changelog.js', 'w').write(c)
    sh('node --check src/changelog.js && node --check src/version.js')
    sh(f"git commit -qam 'Release {ver}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'")
    sh(f'git push -q -f origin HEAD:{branch}')
    # the PR: wait until GitHub has worked out it is mergeable, then squash-merge
    for _ in range(40):
        st = sh(f'gh pr view {branch} --json mergeable,state -q ".mergeable+\\" \\"+.state"', check=False)
        if st.startswith('MERGEABLE'):
            break
        if st.startswith('CONFLICTING'):
            sys.exit('✗ the PR conflicts with main')
        time.sleep(3)
    # GitHub sometimes refuses the merge for a few seconds after a push ('Base branch was modified'), even with the PR
    # mergeable: wait and try again rather than leave a pushed release commit behind (a re-run would add a second one)
    for k in range(10):
        r = subprocess.run(f'gh pr merge {branch} --squash', shell=True, capture_output=True, text=True)
        if r.returncode == 0:
            break
        if 'Base branch was modified' not in r.stderr + r.stdout or k == 9:
            sys.exit(f'✗ gh pr merge {branch} --squash\n{r.stdout}{r.stderr}')
        print('  merge refused (base branch was modified); retrying'); time.sleep(15)
    print(f'merged as {ver}')
    # the deploy: GitHub's deploy-pages step sometimes fails to find its artifact; a fresh run fixes it
    sha = sh('git ls-remote origin refs/heads/main').split()[0]
    for attempt in range(4):
        run = None
        for _ in range(60):
            out = sh('gh run list --workflow "Deploy to GitHub Pages" --limit 5 --json databaseId,headSha,status,conclusion', check=False)
            runs = [r for r in json.loads(out or '[]') if r['headSha'] == sha]
            if runs:
                run = runs[0]
                if run['status'] == 'completed':
                    break
            time.sleep(10)
        if run and run.get('conclusion') == 'success':
            break
        print(f'  deploy attempt {attempt + 1} failed; starting a fresh run')
        sh('gh workflow run "Deploy to GitHub Pages" --ref main', check=False)
        time.sleep(15)
        sha_runs = json.loads(sh('gh run list --workflow "Deploy to GitHub Pages" --limit 1 --json databaseId,headSha', check=False) or '[]')
        if sha_runs:
            sha = sha_runs[0]['headSha']
    for _ in range(30):
        try:
            live = re.search(r"VERSION = '([^']*)'", urllib.request.urlopen(f'{SITE}?x={time.time()}', timeout=20).read().decode()).group(1)
        except Exception:
            live = '?'
        if at_least(live, ver):
            break
        time.sleep(10)
    # (a newer live version contains this one: each release's version is main's + 1 after rebasing onto it, so
    # versions only rise in merge order; another session's release landing first is still a success)
    print(f'deploy {"success" if at_least(live, ver) else "NOT LIVE"} | live {live}' + (f' (includes {ver})' if at_least(live, ver) and live != ver else ''))


if __name__ == '__main__':
    main()
