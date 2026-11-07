# -*- coding: utf-8 -*-
"""pdf_locate.py — webui 校对步骤的教材 PDF 工具（定位习题页 + 渲染裁图）。

用法（输出一律单行 JSON，ensure_ascii）：
  python pdf_locate.py toc    <pdf>                          # 书签目录 [{page,title,level}]
  python pdf_locate.py search <pdf> <query> [--max 40]       # 文字层搜页 [{page,snippet}]
  python pdf_locate.py render <pdf> <page> <out.png> [--dpi 200] [--rect x0,y0,x1,y1]
        # rect 为 0-1 比例（相对页宽高），缺省整页
  python pdf_locate.py pages <pdf> <first> <last> <outdir> [--dpi 150]  # 渲染页码区间（1-based，含端点）
  python pdf_locate.py pagecount <pdf>
  python pdf_locate.py annotate <img> <lines_json> <out.png> [--dpi 200]
        # 在切片图每行开头画蓝色行号标签（lines_json: [{"line":0,"y0":..,"y1":..,"x0":..,"x1":..}...]）
"""
import argparse
import json
import os
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=True))


def cmd_annotate(img_path, lines_json, out_path):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.open(img_path).convert("RGB")
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", max(14, im.width // 60))
    except Exception:
        font = ImageFont.load_default()
    for it in json.load(open(lines_json, encoding="utf-8")):
        y = (it["y0"] + it["y1"]) // 2
        x = max(0, int(it.get("x0", 0)))
        tag = str(it["line"])
        tw = draw.textlength(tag, font=font)
        pad = 3
        box = [max(0, x - tw - 2 * pad - 6), y - pad - 2, x - 6, y + pad + 6]
        draw.rectangle(box, fill=(30, 90, 220))
        draw.text((box[0] + pad, y - pad - 3), tag, fill=(255, 255, 255), font=font)
        draw.line([(x - 2, y), (min(im.width, x + 30), y)], fill=(30, 90, 220), width=1)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    im.save(out_path)
    emit({"ok": 1, "out": out_path})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["toc", "search", "render", "pages", "pagecount", "annotate"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--dpi", type=float, default=200)
    ap.add_argument("--rect", default=None)
    ap.add_argument("--max", type=int, default=40)
    ns = ap.parse_args()

    import pymupdf

    if ns.cmd == "annotate":
        cmd_annotate(ns.args[0], ns.args[1], ns.args[2])
        return

    if ns.cmd == "pagecount":
        doc = pymupdf.open(ns.args[0])
        emit({"pages": doc.page_count})
        return

    if ns.cmd == "toc":
        doc = pymupdf.open(ns.args[0])
        emit([
            {"page": p + 1, "title": t, "level": lv}
            for lv, t, p in doc.get_toc(simple=True)
        ])
        return

    if ns.cmd == "search":
        pdf, query = ns.args[0], ns.args[1]
        doc = pymupdf.open(pdf)
        hits = []
        for i in range(doc.page_count):
            text = doc[i].get_text("text") or ""
            if query in text:
                idx = text.find(query)
                snippet = text[max(0, idx - 20): idx + 60].replace("\n", " ")
                hits.append({"page": i + 1, "snippet": snippet})
                if len(hits) >= ns.max:
                    break
        emit(hits)
        return

    if ns.cmd == "render":
        pdf, page, out = ns.args[0], int(ns.args[1]), ns.args[2]
        doc = pymupdf.open(pdf)
        pg = doc[page - 1]
        rect = pg.rect
        clip = None
        if ns.rect:
            x0, y0, x1, y1 = [float(v) for v in ns.rect.split(",")]
            clip = pymupdf.Rect(rect.x0 + x0 * rect.width, rect.y0 + y0 * rect.height,
                                rect.x0 + x1 * rect.width, rect.y0 + y1 * rect.height)
        pix = pg.get_pixmap(dpi=int(ns.dpi), clip=clip)
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        pix.save(out)
        emit({"ok": 1, "out": out, "w": pix.width, "h": pix.height})
        return

    if ns.cmd == "pages":
        pdf, first, last, outdir = ns.args[0], int(ns.args[1]), int(ns.args[2]), ns.args[3]
        os.makedirs(outdir, exist_ok=True)
        doc = pymupdf.open(pdf)
        out = []
        for p in range(max(1, first), min(doc.page_count, last) + 1):
            f = os.path.join(outdir, f"p{p:03d}.png")
            doc[p - 1].get_pixmap(dpi=int(ns.dpi)).save(f)
            out.append({"page": p, "file": f})
        emit(out)
        return


if __name__ == "__main__":
    main()
