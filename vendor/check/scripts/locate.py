#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""红笔定位工具：量切片图里每一行的位置，或裁一条横带出来看内容。

    # 列出某张切片里每一行「字」的位置（行号、y0..y1、x0..x1）
    python -I locate.py lines "切图1/按题分区/第14题.png"
    python -I locate.py lines 14 --slices 切图1/按题分区 切图2/按题分区

    # 裁一条横带出来看内容（y0 y1 用 lines 量出来的值），可选放大 x2/x3
    python -I locate.py band 14 400 900 x2 --slices 切图1/按题分区 切图2/按题分区
    python -I locate.py band "切图2/按题分区/第30题.png" 1700 1820

说明：
- `<图片|块号>` 给**图片路径**时直接用；给**数字**时按 `--slices` 给出的目录顺序编号
  （第 1 个目录的第 1 张是 1 号，接着往下数），和 redpen.py 的编号方式完全一致。
- `lines` 的判据：某一行暗像素数 >= 3 就算「有字」，相邻行之间由空白带切开。
  输出里的 y 就是写进 notes.py 的那个 y（缺口行的中心 y 也行，redpen.py 会自己居中）。
- `band` 默认写到 ./_bands/，用 Read 工具看图确认那一行到底写了什么。
"""
import argparse
import glob
import os
import re
import sys

import numpy as np
from PIL import Image

# Windows 控制台默认 GBK，中文/花体路径会变乱码；强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


DARK = 140      # 灰度低于这个值算「有字」
MIN_INK = 3     # 一行里至少这么多暗像素才算一行


def slice_list(dirs):
    """按 --slices 的顺序把目录里的 第*.png 收集成一张列表（1 号 = 第 0 个）。"""
    out = []
    for d in dirs:
        files = sorted(glob.glob(os.path.join(d, "第*.png")),
                       key=lambda p: int(re.search(r"(\d+)", os.path.basename(p)).group(1)))
        if not files:
            raise SystemExit("目录里没有 第*.png：%s" % d)
        out.extend(files)
    return out


def resolve(target, dirs):
    """target 是数字就当块号（需要 --slices），否则当路径。"""
    if target.isdigit():
        if not dirs:
            raise SystemExit("给了块号 %s，但没给 --slices 目录" % target)
        lst = slice_list(dirs)
        n = int(target)
        if not (1 <= n <= len(lst)):
            raise SystemExit("块号 %d 越界（--slices 里一共 %d 张）" % (n, len(lst)))
        return lst[n - 1]
    return os.path.abspath(target)


def bands(mask, gap_min=4):
    rows = mask.sum(axis=1)
    flags = rows >= MIN_INK
    out, s = [], None
    for i, v in enumerate(flags):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append([s, i])
            s = None
    if s is not None:
        out.append([s, len(flags)])
    # 合并被细小空白切开的同一行（分数线两侧等）
    merged = []
    for a, b in out:
        if merged and a - merged[-1][1] < gap_min and (merged[-1][1] - merged[-1][0]) < 12:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return merged


def cmd_lines(a):
    path = resolve(a.target, a.slices)
    im = Image.open(path).convert("L")
    mask = np.asarray(im) < DARK
    bs = bands(mask)
    print("%s  %dx%d  %d 行" % (os.path.basename(path), im.width, im.height, len(bs)))
    for i, (y0, y1) in enumerate(bs):
        cols = np.nonzero(mask[y0:y1].sum(axis=0))[0]
        x0, x1 = (int(cols[0]), int(cols[-1])) if len(cols) else (0, 0)
        print("  L%-3d y %-5d..%-5d  h=%-4d x %d..%d" % (i, y0, y1, y1 - y0, x0, x1))
    print("（y0..y1 里任取一个 y 写进 notes.py 都行，取中点最稳）")


def cmd_band(a):
    path = resolve(a.target, a.slices)
    im = Image.open(path).convert("RGB")
    y0, y1 = max(0, a.y0), min(im.height, a.y1)
    if y1 <= y0:
        raise SystemExit("y 区间是空的：%d..%d（图高 %d）" % (y0, y1, im.height))
    c = im.crop((0, y0, im.width, y1))
    zoom = int(a.zoom[1:]) if a.zoom.startswith("x") else int(a.zoom)
    if zoom > 1:
        c = c.resize((c.width * zoom, c.height * zoom), Image.LANCZOS)
    os.makedirs(a.out, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0]
    dst = os.path.join(a.out, "%s_%d_%d%s.png" % (base, y0, y1, a.zoom))
    c.save(dst)
    print(dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("lines", help="列出每一行的位置")
    p1.add_argument("target", help="切片路径，或块号")
    p1.add_argument("--slices", nargs="*", default=[],
                    help="切片目录，按顺序编号（给块号时必需）")
    p1.set_defaults(fn=cmd_lines)

    p2 = sub.add_parser("band", help="裁一条横带出来看内容")
    p2.add_argument("target", help="切片路径，或块号")
    p2.add_argument("y0", type=int)
    p2.add_argument("y1", type=int)
    p2.add_argument("zoom", nargs="?", default="x1", help="放大倍数，如 x2")
    p2.add_argument("--slices", nargs="*", default=[],
                    help="切片目录，按顺序编号（给块号时必需）")
    p2.add_argument("--out", default="_bands", help="输出目录，默认 ./_bands")
    p2.set_defaults(fn=cmd_band)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
