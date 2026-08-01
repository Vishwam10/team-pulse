#!/usr/bin/env python3
"""
Team Pulse — deterministic Google Chat card renderer + poster.

WHY THIS EXISTS: digest.md (run by an LLM) does the non-deterministic work —
gather data, compute signals, write the narratives. It must NOT hand-build the
Chat HTML, because re-deriving the markdown→HTML conversion every run produced a
different formatting bug each time (escaped <font> tags; half-converted [red]).
So the agent just dumps a structured CONTENT JSON and runs this script. The
conversion + cardsV2 assembly + threaded POST live here, committed and tested,
so the formatting can't drift.

USAGE:   python3 render_cards.py [content.json]      (default /tmp/teampulse-cards.json)
Reads ./config.json for the webhook URL, Jira base, GitHub org, sheet id.
Exit 0 only if every card posted (HTTP 200).

CONTENT JSON — all *text* fields use the same extended-markdown the sheet uses:
  **bold**  *italic*  __underline__  ~~strike~~  [red]…[/red] (also green/blue/gray)  [text](url)
Row fields ({text,label,url}): `text` is extended-markdown (bold the id),
`label` is the plain gray sub-line (status · age · review), `url` makes the row tappable.
{
  "thread_key": "teampulse-<UTC TS>",
  "header":  {"attention": "<value, e.g. [red]Name, Name[/red] or [gray]no blockers today[/gray]>",
              "bottleneck": "<one line>"|null,
              "shipped":    "<e.g. [green]**0** merged · **0** closed[/green] [gray](weekend)[/gray]>"},
  "closing": "<team narrative>",
  "teammates": [{
     "name": "Full Name", "icon": "🚩", "github_login": "handle", "jira_account_id": "…",
     "subtitle": "7 active · 0 to-do · 6 in QA · 6 merged (7d)",
     "verdict":  "[red]**Overloaded** · 9 PRs unreviewed[/red] [gray]— 6 active · 38 delivered (awaiting close)[/gray]",
     "needs_attention": [{"text": "**AP-40715** Airbrake error-agent not firing",
                          "label": "Code Review · 290d idle",
                          "url": "https://…/browse/AP-40715"}],
     "in_flight":       [{"text": "**AP-43562** urllib3 CVE fix", "label": "In Progress · 1d", "url": "…"}],
     "prs":             [{"text": "**ChronusMentor#9764** urllib3 2.7.0",
                          "label": "open · 39h · no review", "url": "https://github.com/…/pull/9764"}],
     "activity":  ["**7d** — [green]**6** merged[/green] · **4** reviews · **0** closed · [gray]— docs[/gray]",
                   "**24h** — [gray]Quiet — weekend.[/gray]"],
     "narrative": "<2-3 sentences>"
  }]
}
"""
import json, re, sys, os, subprocess, tempfile, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
cfg  = json.load(open(os.path.join(HERE, "config.json")))
WEBHOOK = cfg.get("gchat_webhook_url", "")
JIRA    = cfg["atlassian_base_url"]
ORG     = cfg["github_org"]
SHEET   = "https://docs.google.com/spreadsheets/d/%s/edit" % cfg["sheet_id"]
if not WEBHOOK:
    sys.exit("render_cards: gchat_webhook_url not set — caller should use the Slack fallback instead")

C = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/teampulse-cards.json"))

# ── extended-markdown → Chat card HTML subset. Insert REAL tags; never html-escape
#    (card content has no <,>,& to encode, and escaping turns tags into literal text). ──
CARD_COLORS = {"red": "#d93025", "green": "#188038", "blue": "#1a73e8", "gray": "#5f6368"}
def to_card_html(s):
    if not s: return ""
    s = re.sub(r'\[/?big\]', '', s)
    for n, h in CARD_COLORS.items():                                    # colours BEFORE links so
        s = re.sub(r'\[' + n + r'\](.*?)\[/' + n + r'\]',               # [gray](3h) isn't eaten
                   r'<font color="' + h + r'">\1</font>', s, flags=re.S)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)
    s = re.sub(r'__([^\n]+?)__', r'<u>\1</u>', s)
    s = re.sub(r'\*\*([^\n]+?)\*\*', r'<b>\1</b>', s)                    # bold before italic
    s = re.sub(r'\*([^\n*]+?)\*', r'<i>\1</i>', s)
    s = re.sub(r'~~([^\n]+?)~~', r'<s>\1</s>', s)
    return s.replace('\n', '<br>')

def tp(t):   return {"textParagraph": {"text": to_card_html(t)}}
def dt(row): # {text, label?, url?}  → tappable labelled row
    w = {"text": to_card_html(row["text"]), "wrapText": True}
    if row.get("label"): w["bottomLabel"] = row["label"]                # plain text, renders gray
    if row.get("url"):   w["onClick"] = {"openLink": {"url": row["url"]}}
    return {"decoratedText": w}
def btns(*pairs):
    return {"buttonList": {"buttons": [{"text": t, "onClick": {"openLink": {"url": u}}} for t, u in pairs]}}
def joined(rows):                                                       # divider between rows
    out = []
    for i, r in enumerate(rows):
        if i: out.append({"divider": {}})
        out.append(dt(r))
    return out
def section(hdr, widgets, collapse=False):
    sec = {"widgets": widgets}
    if hdr: sec["header"] = hdr
    if collapse and len(widgets) > 0:                                   # header+count is the glance
        sec["collapsible"] = True
        sec["uncollapsibleWidgetsCount"] = 0
    return sec
def prs_link(login): return "https://github.com/search?q=" + urllib.parse.quote(
                         "org:%s is:pr is:open author:%s" % (ORG, login)) + "&type=pullrequests"
def jira_link(acct): return JIRA + "/issues/?jql=" + urllib.parse.quote(
                         'assignee = "%s" AND statusCategory != Done ORDER BY updated DESC' % acct)

cards = []

# 1) header card
h = C["header"]
hw = [tp("🚩 **Attention:** " + h.get("attention", ""))]
if h.get("bottleneck"): hw.append(tp("🔁 **Bottleneck:** " + h["bottleneck"]))
hw.append(tp("✅ **Shipped 24h:** " + h.get("shipped", "")))
cards.append({"cardId": "team", "card": {
    "header": {"title": "Team Pulse", "subtitle": C.get("ts", "")},
    "sections": [section(None, hw), section(None, [btns(("📊 Open tracker sheet", SHEET))])]}})

# 2) one card per teammate — verdict, bucketed collapsible rows, activity, narrative+buttons
for t in C["teammates"]:
    secs = [section(None, [tp(t["verdict"])])]
    na, fl, pr = t.get("needs_attention") or [], t.get("in_flight") or [], t.get("prs") or []
    if na: secs.append(section("🔴 Needs attention (%d)" % len(na), joined(na), collapse=True))
    if fl: secs.append(section("🟢 In flight (%d)" % len(fl),       joined(fl), collapse=True))
    if pr: secs.append(section("🔀 Pull requests (%d)" % len(pr),   joined(pr), collapse=True))
    secs.append(section("📊 Activity", [tp(a) for a in t.get("activity", [])]))
    secs.append(section(None, [tp("*%s*" % t["narrative"]),
        btns(("🔀 Open PRs", prs_link(t["github_login"])), ("📋 Jira", jira_link(t["jira_account_id"])))]))
    cards.append({"cardId": t["github_login"], "card": {
        "header": {"title": "%s %s" % (t["icon"], t["name"]), "subtitle": t.get("subtitle", "")},
        "sections": secs}})

# 3) closing card
cards.append({"cardId": "closing", "card": {
    "header": {"title": "🧭 Bottom line"},
    "sections": [section(None, [tp("*%s*" % C["closing"])])]}})

# ── POST each card into one thread (via curl — Python urllib blocked in sandbox) ──
url = WEBHOOK + "&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
TK, ok = C["thread_key"], 0
for c in cards:
    payload = json.dumps({"cardsV2": [c], "thread": {"threadKey": TK}})
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tf:
        tf.write(payload); tf_path = tf.name
    result = subprocess.run(
        ["curl", "-sS", "-w", "\n%{http_code}", "-X", "POST", url,
         "-H", "Content-Type: application/json", "--data", "@" + tf_path],
        capture_output=True, text=True)
    os.unlink(tf_path)
    lines = result.stdout.strip().rsplit("\n", 1)
    http_code = lines[-1] if len(lines) > 1 else "000"
    body_out  = lines[0] if len(lines) > 1 else result.stdout
    if http_code == "200":
        try: name = json.loads(body_out).get("name", "ok")
        except Exception: name = "ok"
        print("  [render_cards] posted %-14s → %s" % (c["cardId"], name)); ok += 1
    else:
        print("  [render_cards] FAIL %s: HTTP %s %s" % (c["cardId"], http_code, body_out[:200]))
print("[render_cards] %d/%d cards posted to thread %s" % (ok, len(cards), TK))
sys.exit(0 if ok == len(cards) else 1)
