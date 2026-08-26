#!/usr/bin/env python3
"""Validate Codex Web self-contained HTML report invariants."""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
import re
import sys


class ReportParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.h1_count = 0
        self.has_charset = False
        self.has_viewport = False
        self.external_assets: list[str] = []
        self.forbidden: list[str] = []
        self.ids: list[str] = []
        self.heading_without_id: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag == "h1":
            self.h1_count += 1
        if tag in {"h2", "h3"} and not values.get("id"):
            self.heading_without_id.append(tag)
        if values.get("id"):
            self.ids.append(values["id"])
        if tag == "meta" and values.get("charset", "").lower().replace("-", "") == "utf8":
            self.has_charset = True
        if tag == "meta" and values.get("name", "").lower() == "viewport" and "width=device-width" in values.get("content", "").lower():
            self.has_viewport = True
        if tag in {"script", "form", "iframe", "object", "embed"}:
            self.forbidden.append(tag)
        if tag == "link" and values.get("href"):
            self.external_assets.append(values["href"])
        for attribute in ("src", "poster", "data"):
            value = values.get(attribute, "").strip()
            if value and not (value.startswith("data:") or value.startswith("#")):
                self.external_assets.append(value)


def validate(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ["file is not valid UTF-8"]
    parser = ReportParser()
    try:
        parser.feed(text)
    except Exception as exc:
        errors.append(f"HTML parsing failed: {exc}")
    if not re.search(r"<!doctype\s+html", text, re.IGNORECASE):
        errors.append("missing HTML5 doctype")
    if not parser.has_charset:
        errors.append('missing <meta charset="utf-8">')
    if not parser.has_viewport:
        errors.append("missing responsive viewport meta tag")
    if parser.h1_count != 1:
        errors.append(f"expected exactly one h1, found {parser.h1_count}")
    if len(parser.ids) != len(set(parser.ids)):
        errors.append("duplicate id attributes found")
    if parser.heading_without_id:
        errors.append("headings without stable ids: " + ", ".join(parser.heading_without_id[:8]))
    if parser.forbidden:
        errors.append("forbidden active elements: " + ", ".join(sorted(set(parser.forbidden))))
    if parser.external_assets:
        errors.append("non-self-contained asset references: " + ", ".join(parser.external_assets[:8]))
    if re.search(r"url\(\s*['\"]?https?://", text, re.IGNORECASE):
        errors.append("external URL found in CSS url()")
    if re.search(r"(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(", text, re.IGNORECASE):
        errors.append("CSS gradients are not allowed; use restrained solid fills")
    return errors


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("report", type=Path)
    args = argument_parser.parse_args()
    if not args.report.is_file():
        print(f"ERROR: file not found: {args.report}", file=sys.stderr)
        return 2
    errors = validate(args.report)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"OK: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
