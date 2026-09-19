"""mitmproxy addon: log the Tablo device's private API as the app exercises it.

The 4th-gen device API is plain HTTP on 8887 (HMAC-signed, no TLS), so it is
captured with no certificate at all - point the phone's proxy at this host and
drive the official app. The cloud calls (lighthousetv) are HTTPS and need the
mitmproxy CA trusted on the phone; they are logged too when they come through.

    mitmdump -s backend/tools/mitm_tablo.py --set tablo_ip=172.16.16.121

Every request to the device or the cloud prints as
    METHOD  status  path            <- has body / query
and on exit a de-duplicated list of METHOD+path templates (numeric ids folded
to {id}) is written to tablo_endpoints.txt - the map, minus the noise of every
individual airing id.
"""

import json
import re
from collections import OrderedDict

from mitmproxy import ctx, http

SEEN: "OrderedDict[str, dict]" = OrderedDict()


def load(loader):
    loader.add_option("tablo_ip", str, "172.16.16.121", "Device LAN IP")


def _template(path: str) -> str:
    # Fold numeric ids and long tokens so 9,000 airing paths collapse to one.
    path = re.sub(r"/\d+", "/{id}", path)
    path = re.sub(r"/[0-9a-f]{8}-[0-9a-f-]{27,}", "/{uuid}", path)
    return path.split("?", 1)[0]


def _is_tablo(host: str) -> bool:
    return host == ctx.options.tablo_ip or "ewscloud.com" in host


def response(flow: http.HTTPFlow):
    host = flow.request.pretty_host
    if not _is_tablo(host):
        return
    req, resp = flow.request, flow.response
    tmpl = f"{req.method} {_template(req.path)}"
    tags = []
    if req.query:
        tags.append("query=" + ",".join(req.query.keys()))
    if req.content:
        tags.append(f"body[{len(req.content)}]")
    port = f":{req.port}" if req.port not in (80, 443) else ""
    ctx.log.info(
        f"{req.method:6} {resp.status_code}  {host}{port}{req.path}"
        + (f"   <- {'; '.join(tags)}" if tags else "")
    )
    # Keep the first example of each template, with a sample request body.
    if tmpl not in SEEN:
        body = None
        if req.content:
            try:
                body = json.loads(req.content)
            except ValueError:
                body = req.get_text()[:200]
        SEEN[tmpl] = {"host": host, "port": req.port,
                      "query": list(req.query.keys()), "body": body}


def done():
    out = "tablo_endpoints.txt"
    with open(out, "w") as f:
        for tmpl, meta in sorted(SEEN.items()):
            f.write(tmpl + "\n")
            if meta["query"]:
                f.write(f"    query: {meta['query']}\n")
            if meta["body"] is not None:
                f.write(f"    body:  {json.dumps(meta['body'])[:300]}\n")
    ctx.log.info(f"\nwrote {len(SEEN)} unique endpoints to {out}")
