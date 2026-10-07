#!/usr/bin/env python3
"""Create a Cap site key. Usage: mkkey.py '<json config>'  -> prints "siteKey secretKey"."""
import base64, json, sys, urllib.request

BASE = "http://127.0.0.1:3010"
import os
ADMIN = os.environ.get("ADMIN_KEY", "change-me-local-lab-key")


def post(path, body, tok=None, method="POST"):
    headers = {"content-type": "application/json"}
    if tok:
        headers["authorization"] = tok
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


d = post("/auth/login", {"admin_key": ADMIN})
tok = "Bearer " + base64.b64encode(
    json.dumps({"token": d["session_token"], "hash": d["hashed_token"]}).encode()
).decode()

cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
k = post("/server/keys", cfg, tok)
# difficulty / challengeCount / ratelimit are only settable via the config route
patchable = {"difficulty", "challengeCount", "ratelimitMax", "ratelimitDuration"}
extra = {k2: v for k2, v in cfg.items() if k2 in patchable}
if extra:
    post(f"/server/keys/{k['siteKey']}/config", extra, tok, method="PUT")
print(k["siteKey"], k["secretKey"])