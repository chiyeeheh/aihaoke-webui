#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把手写切片 + 红笔订正 合成一张图（这一步的最终交付物）。

    python -I redpen.py                          # 按 notes.py 里的 SLICES/OUT 全跑一遍
    python -I redpen.py 3 5                      # 只重做这几个块（调试用）
    python -I redpen.py --slices 切图1/按题分区 切图2/按题分区 --out 图片_手写订正

流程：切片图 → 右侧接一条空白页边 → 红字（黑体中文 + MathJax 数学）贴到出错那一行旁边
      → 从切口拉一条红色折线指过去 → 存成 第NN题.png
红字先由无头 Chrome 渲染成透明 PNG（超采样再缩回），所以分数、根号、上下标都是规整排出来的。

订正数据表默认是当前目录的 notes.py（格式见 scripts/notes.example.py）：
    NOTES = { 块号: [ (目标行的中心 y, 红字 HTML), ... ] }

中间产物（生成的 HTML、红字 PNG、jobs.json）放在 <work>/_redpen/ 下，
下次重跑时按 HTML 内容做缓存 —— 只重截改动过的那几条，没改的直接复用。
"""
import argparse
import glob
import io
import importlib.util
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw

# Windows 控制台默认 GBK，中文/花体路径会变乱码；强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


HERE = os.path.dirname(os.path.abspath(__file__))
NODE_MODULES = os.path.join(HERE, "node_modules")

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

TEMPLATE = """<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<script>
MathJax = { tex: {inlineMath: [['$','$']]}, svg: {fontCache: 'local'},
            startup: {typeset: true} };
</script>
<script src="%(mj)s"></script>
<style>
 html, body { background: transparent; margin:0; padding:0; }
 #snip { display:inline-block; background:transparent; max-width:%(mw)dpx;
         font-family:%(ff)s; font-size:%(fs)dpx;
         line-height:1.55; color:%(col)s; }
</style></head><body><div id="snip">%(body)s</div></body></html>
"""


def find_chrome(explicit=None):
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise SystemExit("--chrome 给的路径不存在：%s" % explicit)
    env = os.environ.get("CHROME_PATH")
    if env and os.path.exists(env):
        return env
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("没找到 Chrome 或 Edge。装一个，或用 --chrome <路径> 指定。")


def ensure_node_deps():
    if os.path.exists(os.path.join(NODE_MODULES, "mathjax", "es5", "tex-svg.js")):
        return
    print("WARN 首次运行，正在装 Node 依赖（约 75MB，等一两分钟）…")
    r = subprocess.run(["npm", "install"], cwd=HERE, capture_output=True, text=True,
                       shell=(os.name == "nt"))
    if r.returncode != 0:
        raise SystemExit("npm install 失败：\n%s\n%s" % (r.stdout, r.stderr))


def load_notes(path):
    if not os.path.exists(path):
        raise SystemExit("找不到订正表：%s（可复制 scripts/notes.example.py 起头）" % path)
    spec = importlib.util.spec_from_file_location("_notes", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not getattr(mod, "NOTES", None):
        raise SystemExit("%s 里没有 NOTES" % path)
    return mod


def resolve_path(p, notes_dir):
    """相对路径：先按当前目录找，再按订正表所在目录找。"""
    if os.path.isabs(p) or os.path.exists(p):
        return os.path.abspath(p)
    return os.path.abspath(os.path.join(notes_dir, p))


def slice_list(dirs):
    out = []
    for d in dirs:
        files = sorted(glob.glob(os.path.join(d, "第*.png")),
                       key=lambda p: int(re.search(r"(\d+)", os.path.basename(p)).group(1)))
        if not files:
            raise SystemExit("目录里没有 第*.png：%s" % d)
        out.extend(files)
    return out


def render_notes(items, work, a):
    """items: [(key, html)] → {key: PIL 图}（已缩回 1 倍）"""
    html_dir = os.path.join(work, "_redpen", "html")
    png_dir = os.path.join(work, "_redpen", "png")
    os.makedirs(html_dir, exist_ok=True)
    os.makedirs(png_dir, exist_ok=True)
    mj = "file:///" + os.path.join(NODE_MODULES.replace("\\", "/"),
                                   "mathjax/es5/tex-svg.js")
    todo = []
    for key, body in items:
        html = TEMPLATE % {"mj": mj, "fs": a.css, "body": body, "mw": a.max_w,
                           "ff": a.font, "col": "#%02x%02x%02x" % a.color}
        hp = os.path.join(html_dir, key + ".html")
        pp = os.path.join(png_dir, key + ".png")
        old = io.open(hp, encoding="utf-8").read() if os.path.exists(hp) else None
        if old != html or not os.path.exists(pp):
            io.open(hp, "w", encoding="utf-8").write(html)
            todo.append(key)
    if todo:
        cfg = {"chrome": a.chrome, "htmlDir": html_dir, "outDir": png_dir,
               "scale": a.scale, "only": todo}
        cfgp = os.path.join(work, "_redpen", "jobs.json")
        io.open(cfgp, "w", encoding="utf-8").write(json.dumps(cfg, ensure_ascii=False))
        r = subprocess.run(["node", os.path.join(HERE, "snip.js"), cfgp], cwd=HERE,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise SystemExit("截图失败:\n%s\n%s" % (r.stdout, r.stderr))
        for ln in r.stdout.splitlines():
            print("   " + ln)
    else:
        print("   红字素材没变，跳过截图")
    out = {}
    for key, _ in items:
        p = os.path.join(png_dir, key + ".png")
        if not os.path.exists(p):
            raise SystemExit("缺片段 %s" % key)
        im = Image.open(p).convert("RGBA")
        out[key] = im.resize((max(1, im.width // a.scale), max(1, im.height // a.scale)),
                             Image.LANCZOS)
    return out


def compose(src_path, dst_path, notes, pngs, a):
    src = Image.open(src_path).convert("RGB")
    W, H = src.width, src.height
    ws = [pngs[nt["key"]].width for nt in notes]
    margin = min(max(ws) + 70, a.margin_max)

    # 先把位置排好。往下让位时允许超出原图底边 —— 画布跟着加高，避免「夹到底边还撞」的死循环
    placed = []
    for nt in sorted(notes, key=lambda x: x["y"]):
        im = pngs[nt["key"]]
        y = max(a.pad_top, int(nt["y"] - im.height / 2))
        while any(abs(y - py) < (im.height + pim.height) // 2 + 6
                 for py, pim, _ in placed):
            y += 18
        placed.append((y, im, nt))

    HOUT = max([H] + [y + im.height + 10 for y, im, _ in placed])
    out = Image.new("RGB", (W + margin, HOUT), (255, 255, 255))
    out.paste(src, (0, 0))
    d = ImageDraw.Draw(out)
    # 切口处一条淡竖线，表明右边是加出来的空白页边
    d.line([(W, 0), (W, H)], fill=(216, 216, 216), width=1)

    for y, im, nt in placed:
        x = W + a.gap
        out.paste(im, (x, y), im)
        # 折线：目标行上的红点 → 横向出切口 → 竖直对齐到红字中线 → 横向接到红字
        yc = y + im.height // 2
        ty = max(8, min(int(nt["y"]), H - 9))
        xe = W + 22
        d.line([(W + 4, ty), (xe, ty)], fill=a.color, width=2)
        if abs(ty - yc) > 2:
            d.line([(xe, ty), (xe, yc)], fill=a.color, width=2)
        d.line([(xe, yc), (x - 10, yc)], fill=a.color, width=2)
        d.ellipse([W + 2, ty - 3, W + 8, ty + 3], fill=a.color)

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    out.save(dst_path)
    return out.size


def out_name(path, i):
    """切片文件名若是 第14题.png 就沿用，否则按序编号。"""
    m = re.match(r"第(\d+)题$", os.path.splitext(os.path.basename(path))[0])
    return "第%s题.png" % (m.group(1) if m else str(i).zfill(2))


def main():
    ap = argparse.ArgumentParser(description="手写切片 + 红笔订正 → 交付图",
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("blocks", nargs="*", type=int, help="只重做这些块（默认全部）")
    ap.add_argument("--notes", default="notes.py", help="订正数据表，默认 ./notes.py")
    ap.add_argument("--slices", nargs="*", default=None,
                    help="切片目录（按顺序编号）；不给就用 notes.py 里的 SLICES")
    ap.add_argument("--out", default=None, help="交付目录；不给就用 notes.py 里的 OUT")
    ap.add_argument("--work", default=None, help="中间产物目录；默认订正表所在目录")
    ap.add_argument("--font", default='"SimHei","SimSun",sans-serif',
                    help="红字字体，默认黑体")
    ap.add_argument("--css", type=int, default=30, help="红字字号（CSS px，最终图上就多大）")
    ap.add_argument("--scale", type=int, default=2, help="超采样倍率，2 = 先 2 倍再缩一半")
    ap.add_argument("--gap", type=int, default=46, help="切口与红字之间的横向空隙")
    ap.add_argument("--pad-top", type=int, default=26, help="红字离图顶至少留这么多")
    ap.add_argument("--max-w", type=int, default=640, help="红字最宽（超出自动换行）")
    ap.add_argument("--margin-max", type=int, default=900, help="右侧加出来的白边最宽")
    ap.add_argument("--color", default="204,0,0", help="红笔颜色 R,G,B")
    ap.add_argument("--chrome", default=None, help="Chrome/Edge 可执行文件路径")
    a = ap.parse_args()
    a.color = tuple(int(x) for x in a.color.split(","))

    notes_path = os.path.abspath(a.notes)
    notes_dir = os.path.dirname(notes_path)
    mod = load_notes(notes_path)
    a.work = os.path.abspath(a.work or notes_dir)

    dirs = a.slices if a.slices is not None else list(getattr(mod, "SLICES", None) or [])
    dirs = [resolve_path(d, notes_dir) for d in dirs]
    if not dirs:
        raise SystemExit("没给切片目录：用 --slices，或在 notes.py 里写 SLICES = [...]")
    slices = slice_list(dirs)
    out_dir = a.out or getattr(mod, "OUT", None) or os.path.join(a.work, "红笔图")
    out_dir = resolve_path(out_dir, notes_dir)

    a.chrome = find_chrome(a.chrome)
    ensure_node_deps()

    only = set(a.blocks) if a.blocks else set(mod.NOTES)
    bad = sorted(n for n in only if not (1 <= n <= len(slices)))
    if bad:
        raise SystemExit("块号越界：%s（一共 %d 块）" % (bad, len(slices)))

    items, plan = [], {}
    for n in sorted(mod.NOTES):
        notes = []
        for i, nt in enumerate(mod.NOTES[n]):
            key = "b%02d_%d" % (n, i)
            notes.append({"key": key, "y": nt[0]})
            items.append((key, nt[1]))
        plan[n] = notes
    items = [it for it in items if int(it[0][1:3]) in only]
    pngs = render_notes(items, a.work, a)

    for n in sorted(plan):
        if n not in only:
            continue
        dst = os.path.join(out_dir, out_name(slices[n - 1], n))
        w, h = compose(slices[n - 1], dst, plan[n], pngs, a)
        print("OUT %s  %dx%d" % (dst, w, h))

    # 没订正的块也照样出一份（原图），交付目录里 NN 张齐全
    if not a.blocks:
        k = 0
        for i, sp in enumerate(slices, 1):
            if i in mod.NOTES:
                continue
            Image.open(sp).convert("RGB").save(os.path.join(out_dir, out_name(sp, i)))
            k += 1
        print("另外 %d 块没有订正，原样输出" % k)
        print("交付目录：%s（共 %d 张）" % (out_dir, len(slices)))


if __name__ == "__main__":
    main()
