#!/usr/bin/env python3
"""Build the two double-click files from the prototype source.

    python3 build.py

Produces, next to this script:
  dait-crm.html      <- index.html + css/app.css + js/*.js + assets/*.png (inlined)
  contact-form.html  <- public/contact.html + css/app.css + js/data.js + js/store.js + logo (inlined)

Edit the source files, then run this script. Never edit the two output files by hand.
Only the Montserrat web font is still loaded from Google Fonts; offline, the browser falls back to a system font.
"""
import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def data_uri(rel):
    raw = (ROOT / rel).read_bytes()
    mime = "image/svg+xml" if rel.endswith(".svg") else "image/png"
    return "data:" + mime + ";base64," + base64.b64encode(raw).decode("ascii")


def inline(html, base):
    """Inline the stylesheet and every <script src> relative to `base` (a folder under ROOT)."""
    def css(m):
        return "<style>\n" + read((base / m.group(1)).as_posix()) + "\n</style>"

    def js(m):
        code = read((base / m.group(1)).as_posix())
        # a literal closing tag inside JS would end the inline <script> early
        code = code.replace("</script", "<\\/script")
        return "<script>\n" + code + "\n</script>"

    html = re.sub(r'<link rel="stylesheet" href="([^"]+\.css)">', css, html)
    html = re.sub(r'<script src="([^"]+\.js)"></script>', js, html)
    return html


def inline_logos(html):
    for name in ("logo-full.png", "logo-mark.png", "logo-mark-white.svg", "logo-mark.svg"):
        uri = data_uri("assets/" + name)
        html = html.replace("../assets/" + name, uri).replace("assets/" + name, uri)
    return html


def build_crm():
    html = inline(read("index.html"), pathlib.Path("."))
    html = inline_logos(html)
    html = html.replace("public/contact.html", "contact-form.html")
    (ROOT / "dait-crm.html").write_text(html, encoding="utf-8")


def build_form():
    html = inline(read("public/contact.html"), pathlib.Path("public"))
    html = inline_logos(html)
    html = html.replace("../index.html", "dait-crm.html")
    html = html.replace('href="contact.html"', 'href="contact-form.html"')
    (ROOT / "contact-form.html").write_text(html, encoding="utf-8")


if __name__ == "__main__":
    build_crm()
    build_form()
    for out in ("dait-crm.html", "contact-form.html"):
        print(f"built {out} ({(ROOT / out).stat().st_size // 1024} KB)")
